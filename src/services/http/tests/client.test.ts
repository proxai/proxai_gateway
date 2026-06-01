import { describe, expect, test } from 'bun:test';

import {
  AuthError,
  FatalError,
  NetworkError,
  RateLimitError,
  requireDefined,
  RetriableError,
  ValidationError,
  WatermarkRegressionError,
} from 'core/utils';
import type { FetchFn } from 'core/utils';
import type { RawRecordDTO } from 'services/contract';
import { HttpClient } from 'services/http';
import type { HttpEndpoints } from 'services/http';

const VALID_UUID = '01943f5a-7b1c-7e92-9c01-a0f3b40d77e3';
const VALID_SHA256 = 'a'.repeat(64);

const endpoints: HttpEndpoints = {
  ingest: 'https://api.example.com/v1/raw_records',
  verifyKey: 'https://api.example.com/ingestion/verify-key',
  watermarks: 'https://api.example.com/v1/watermarks',
  registerHostId: 'https://api.example.com/v1/host-ids/register',
};

interface MockCall {
  url: string;
  init: RequestInit;
}

function mockFetch(
  responder: (call: MockCall) => Response | Promise<Response> | Error,
  log?: MockCall[],
): FetchFn {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const call: MockCall = { url, init: init ?? {} };
    log?.push(call);
    const result = await responder(call);
    if (result instanceof Error) throw result;
    return result;
  }) as FetchFn;
}

function createClient(fetchFn: FetchFn): HttpClient {
  return new HttpClient({
    apiKey: 'pxg-20260505-secret',
    hostId: 'h_test',
    endpoints,
    fetch: fetchFn,
  });
}

function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (extraHeaders) Object.assign(headers, extraHeaders);
  return new Response(JSON.stringify(body), { status, headers });
}

function emptyResponse(status: number, extraHeaders?: Record<string, string>): Response {
  const headers: Record<string, string> = {};
  if (extraHeaders) Object.assign(headers, extraHeaders);
  return new Response('', { status, headers });
}

function validDto(): RawRecordDTO {
  return {
    capture_id: VALID_UUID,
    host_id: 'h_test',
    source_app: 'claude-code',
    source_kind: 'jsonl_append',
    source_path: '/test/session.jsonl',
    source_path_hash: VALID_SHA256,
    source_inode: 1,
    watermark: { kind: 'byte_range', start: 0, end: 100, table: null },
    agent_schema_version: '1.0',
    gateway_version: '0.1.0',
    captured_at_utc: '2026-04-29T10:42:00.123Z',
    body_format: 'jsonl',
    body_compression: 'zstd',
    body: 'aGVsbG8=',
  };
}

describe('uploadRawRecord', () => {
  test('returns parsed result on 200', async () => {
    const client = createClient(
      mockFetch(() => jsonResponse({ capture_id: VALID_UUID, accepted: true, idempotent: false })),
    );
    const result = await client.uploadRawRecord(validDto());
    expect(result.captureId).toBe(VALID_UUID);
    expect(result.accepted).toBe(true);
    expect(result.idempotent).toBe(false);
  });

  test('translates idempotent: true responses', async () => {
    const client = createClient(
      mockFetch(() => jsonResponse({ capture_id: VALID_UUID, accepted: true, idempotent: true })),
    );
    const result = await client.uploadRawRecord(validDto());
    expect(result.idempotent).toBe(true);
  });

  test('validates DTO before sending (no fetch on invalid)', async () => {
    const log: MockCall[] = [];
    const client = createClient(mockFetch(() => jsonResponse({}), log));
    const bad = { ...validDto(), capture_id: 'not-a-uuid' };
    await expect(client.uploadRawRecord(bad)).rejects.toThrow(ValidationError);
    expect(log).toHaveLength(0);
  });

  test('throws ValidationError on 400', async () => {
    const client = createClient(mockFetch(() => emptyResponse(400)));
    await expect(client.uploadRawRecord(validDto())).rejects.toThrow(ValidationError);
  });

  test('throws WatermarkRegressionError when 400 body is structured', async () => {
    const client = createClient(
      mockFetch(
        () =>
          new Response(
            JSON.stringify({
              error: 'watermark_regression',
              current_server_watermark_end: 7777,
              source_path_hash: 'h_abc',
            }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    );
    try {
      await client.uploadRawRecord(validDto());
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(WatermarkRegressionError);
      expect((err as WatermarkRegressionError).currentServerWatermarkEnd).toBe(7777);
      expect((err as WatermarkRegressionError).sourcePathHash).toBe('h_abc');

      expect(err).toBeInstanceOf(ValidationError);
    }
  });

  test('throws plain ValidationError when 400 body is not the regression shape', async () => {
    const client = createClient(
      mockFetch(
        () =>
          new Response(JSON.stringify({ error: 'something_else' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );
    try {
      await client.uploadRawRecord(validDto());
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect(err).not.toBeInstanceOf(WatermarkRegressionError);
    }
  });

  test('throws AuthError on 403 with host-not-authorized message', async () => {
    const client = createClient(mockFetch(() => emptyResponse(403)));
    await expect(client.uploadRawRecord(validDto())).rejects.toThrow(
      'server returned 403: host not authorized for this gateway key',
    );
  });

  test('throws ValidationError on 408', async () => {
    const client = createClient(mockFetch(() => emptyResponse(408)));
    await expect(client.uploadRawRecord(validDto())).rejects.toThrow(ValidationError);
  });

  test('throws ValidationError on 413', async () => {
    const client = createClient(mockFetch(() => emptyResponse(413)));
    await expect(client.uploadRawRecord(validDto())).rejects.toThrow(ValidationError);
  });

  test('throws RateLimitError on 429 with parsed Retry-After (seconds)', async () => {
    const client = createClient(mockFetch(() => emptyResponse(429, { 'Retry-After': '30' })));
    try {
      await client.uploadRawRecord(validDto());
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfterMs).toBe(30_000);
    }
  });

  test('throws RateLimitError on 429 without Retry-After', async () => {
    const client = createClient(mockFetch(() => emptyResponse(429)));
    try {
      await client.uploadRawRecord(validDto());
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect((err as RateLimitError).retryAfterMs).toBeNull();
    }
  });

  test('throws RetriableError on 502', async () => {
    const client = createClient(mockFetch(() => emptyResponse(502)));
    await expect(client.uploadRawRecord(validDto())).rejects.toThrow(RetriableError);
  });

  test('throws RetriableError on 503 (kill switch)', async () => {
    const client = createClient(mockFetch(() => emptyResponse(503)));
    await expect(client.uploadRawRecord(validDto())).rejects.toThrow(RetriableError);
  });

  test('throws NetworkError when fetch fails', async () => {
    const client = createClient(mockFetch(() => new Error('connection refused')));
    await expect(client.uploadRawRecord(validDto())).rejects.toThrow(NetworkError);
  });

  test('throws FatalError on unexpected status', async () => {
    const client = createClient(mockFetch(() => emptyResponse(418)));
    await expect(client.uploadRawRecord(validDto())).rejects.toThrow(FatalError);
  });

  test('thrown error carries http context with url, method, status, and body excerpt', async () => {
    const body = JSON.stringify({ success: false, error: { message: 'Internal Server Error' } });
    const client = createClient(
      mockFetch(
        () => new Response(body, { status: 500, headers: { 'Content-Type': 'application/json' } }),
      ),
    );
    let caught: unknown;
    try {
      await client.uploadRawRecord(validDto());
    } catch (e) {
      caught = e;
    }
    const err = caught as {
      httpContext?: {
        url: string;
        method: string;
        status: number | null;
        bodyExcerpt: string | null;
      };
    };
    expect(err.httpContext?.method).toBe('POST');
    expect(err.httpContext?.url).toBe('https://api.example.com/v1/raw_records');
    expect(err.httpContext?.status).toBe(500);
    expect(err.httpContext?.bodyExcerpt).toContain('Internal Server Error');
  });

  test('http context body excerpt is truncated at 512 chars with ellipsis', async () => {
    const body = 'x'.repeat(2000);
    const client = createClient(mockFetch(() => new Response(body, { status: 500 })));
    let caught: unknown;
    try {
      await client.uploadRawRecord(validDto());
    } catch (e) {
      caught = e;
    }
    const err = caught as { httpContext?: { bodyExcerpt: string | null } };
    expect(err.httpContext?.bodyExcerpt?.length).toBe(513);
    expect(err.httpContext?.bodyExcerpt?.endsWith('…')).toBe(true);
  });

  test('http context records null status on network failure', async () => {
    const client = createClient(mockFetch(() => new Error('connection refused')));
    let caught: unknown;
    try {
      await client.uploadRawRecord(validDto());
    } catch (e) {
      caught = e;
    }
    const err = caught as {
      httpContext?: { url: string; status: number | null; bodyExcerpt: string | null };
    };
    expect(err.httpContext?.url).toBe('https://api.example.com/v1/raw_records');
    expect(err.httpContext?.status).toBeNull();
    expect(err.httpContext?.bodyExcerpt).toBeNull();
  });

  test('http context attaches to FatalError on empty 200 body', async () => {
    const client = createClient(mockFetch(() => new Response('', { status: 200 })));
    let caught: unknown;
    try {
      await client.uploadRawRecord(validDto());
    } catch (e) {
      caught = e;
    }
    const err = caught as { httpContext?: { status: number | null; bodyExcerpt: string | null } };
    expect(err.httpContext?.status).toBe(200);
    expect(err.httpContext?.bodyExcerpt).toBe('');
  });

  test('http context attaches to FatalError when 200 body is invalid JSON', async () => {
    const client = createClient(mockFetch(() => new Response('not-json', { status: 200 })));
    let caught: unknown;
    try {
      await client.uploadRawRecord(validDto());
    } catch (e) {
      caught = e;
    }
    const err = caught as { httpContext?: { status: number | null; bodyExcerpt: string | null } };
    expect(err.httpContext?.status).toBe(200);
    expect(err.httpContext?.bodyExcerpt).toBe('not-json');
  });

  test('http context records request timeout with null status', async () => {
    const client = createClient(
      mockFetch(() => {
        const e: Error & { name: string } = new Error('timeout') as Error & { name: string };
        e.name = 'TimeoutError';
        return e;
      }),
    );
    let caught: unknown;
    try {
      await client.uploadRawRecord(validDto());
    } catch (e) {
      caught = e;
    }
    const err = caught as { httpContext?: { status: number | null } };
    expect(err.httpContext?.status).toBeNull();
  });

  test('sends X-API-Key header on upload', async () => {
    const log: MockCall[] = [];
    const client = createClient(
      mockFetch(
        () => jsonResponse({ capture_id: VALID_UUID, accepted: true, idempotent: false }),
        log,
      ),
    );
    await client.uploadRawRecord(validDto());
    const headers = requireDefined(log[0]).init.headers as Record<string, string>;
    expect(headers['X-API-Key']).toBe('pxg-20260505-secret');
    expect(headers['Authorization']).toBeUndefined();
  });

  test('sets User-Agent header', async () => {
    const log: MockCall[] = [];
    const client = createClient(
      mockFetch(
        () => jsonResponse({ capture_id: VALID_UUID, accepted: true, idempotent: false }),
        log,
      ),
    );
    await client.uploadRawRecord(validDto());
    const headers = requireDefined(log[0]).init.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe('@proxai/gateway');
  });

  test('serializes the DTO as JSON in the request body', async () => {
    const log: MockCall[] = [];
    const client = createClient(
      mockFetch(
        () => jsonResponse({ capture_id: VALID_UUID, accepted: true, idempotent: false }),
        log,
      ),
    );
    await client.uploadRawRecord(validDto());
    const body = JSON.parse(requireDefined(log[0]).init.body as string);
    expect(body.capture_id).toBe(VALID_UUID);
    expect(body.source_app).toBe('claude-code');
  });

  test('POSTs to the ingest endpoint', async () => {
    const log: MockCall[] = [];
    const client = createClient(
      mockFetch(
        () => jsonResponse({ capture_id: VALID_UUID, accepted: true, idempotent: false }),
        log,
      ),
    );
    await client.uploadRawRecord(validDto());
    expect(requireDefined(log[0]).url).toBe(endpoints.ingest);
    expect(requireDefined(log[0]).init.method).toBe('POST');
  });
});

describe('verifyKey', () => {
  test('returns success on 200 with success: true', async () => {
    const client = createClient(
      mockFetch(() =>
        jsonResponse({
          success: true,
          data: { keyName: 'my-key', userId: 'u_1' },
          message: 'Key verified successfully',
        }),
      ),
    );
    const result = await client.verifyKey();
    expect(result.success).toBe(true);
    expect(result.message).toBe('Key verified successfully');
    expect(result.userId).toBe('u_1');
    expect(result.keyName).toBe('my-key');
  });

  test('returns success: false with null userId when server returns 200 with success: false', async () => {
    const client = createClient(
      mockFetch(() => jsonResponse({ success: false, message: 'expired' })),
    );
    const result = await client.verifyKey();
    expect(result.success).toBe(false);
    expect(result.message).toBe('expired');
    expect(result.userId).toBeNull();
    expect(result.keyName).toBeNull();
  });

  test('returns null userId/keyName when data is missing on success', async () => {
    const client = createClient(mockFetch(() => jsonResponse({ success: true, message: 'ok' })));
    const result = await client.verifyKey();
    expect(result.success).toBe(true);
    expect(result.userId).toBeNull();
    expect(result.keyName).toBeNull();
  });

  test('returns null userId when data.userId is not a string', async () => {
    const client = createClient(
      mockFetch(() =>
        jsonResponse({
          success: true,
          data: { keyName: 'my-key', userId: 12345 },
          message: 'ok',
        }),
      ),
    );
    const result = await client.verifyKey();
    expect(result.userId).toBeNull();
    expect(result.keyName).toBe('my-key');
  });

  test('GETs the verify-key endpoint and sends the X-API-Key header', async () => {
    const log: MockCall[] = [];
    const client = createClient(
      mockFetch(() => jsonResponse({ success: true, message: 'Key verified successfully' }), log),
    );
    await client.verifyKey();
    expect(requireDefined(log[0]).url).toBe(endpoints.verifyKey);
    expect(requireDefined(log[0]).init.method).toBe('GET');
    const headers = requireDefined(log[0]).init.headers as Record<string, string>;
    expect(headers['X-API-Key']).toBe('pxg-20260505-secret');
  });

  test('throws AuthError on 403 (host not authorized)', async () => {
    const client = createClient(mockFetch(() => emptyResponse(403)));
    await expect(client.verifyKey()).rejects.toThrow(AuthError);
  });

  test('throws RetriableError on 503', async () => {
    const client = createClient(mockFetch(() => emptyResponse(503)));
    await expect(client.verifyKey()).rejects.toThrow(RetriableError);
  });

  test('hostIdentifier exposes hostId for telemetry consumers', () => {
    const client = createClient(mockFetch(() => emptyResponse(200)));
    expect(client.hostIdentifier).toBe('h_test');
  });

  test('falls back to empty message when server omits it', async () => {
    const client = createClient(mockFetch(() => jsonResponse({ success: true })));
    const result = await client.verifyKey();
    expect(result.message).toBe('');
  });
});

describe('error response parsing', () => {
  test('throws FatalError on unparseable 200 body', async () => {
    const client = createClient(mockFetch(() => new Response('not json', { status: 200 })));
    await expect(client.verifyKey()).rejects.toThrow(FatalError);
  });

  test('throws FatalError on empty 200 body', async () => {
    const client = createClient(mockFetch(() => emptyResponse(200)));
    await expect(client.verifyKey()).rejects.toThrow(FatalError);
  });
});

describe('registerHostId', () => {
  test('returns parsed result on 200 with all fields present', async () => {
    const client = createClient(
      mockFetch(() => jsonResponse({ host_id: 'h_abc', user_id: 'u_xyz', registered: true })),
    );
    const result = await client.registerHostId();
    expect(result.hostId).toBe('h_abc');
    expect(result.userId).toBe('u_xyz');
    expect(result.registered).toBe(true);
  });

  test('returns registered: false when server returns false', async () => {
    const client = createClient(
      mockFetch(() => jsonResponse({ host_id: 'h_abc', user_id: 'u_xyz', registered: false })),
    );
    const result = await client.registerHostId();
    expect(result.registered).toBe(false);
  });

  test('falls back to empty string for host_id when field is missing', async () => {
    const client = createClient(
      mockFetch(() => jsonResponse({ user_id: 'u_xyz', registered: true })),
    );
    const result = await client.registerHostId();
    expect(result.hostId).toBe('');
  });

  test('falls back to empty string for user_id when field is missing', async () => {
    const client = createClient(
      mockFetch(() => jsonResponse({ host_id: 'h_abc', registered: true })),
    );
    const result = await client.registerHostId();
    expect(result.userId).toBe('');
  });

  test('falls back to empty string for host_id when field is not a string', async () => {
    const client = createClient(
      mockFetch(() => jsonResponse({ host_id: 42, user_id: 'u_xyz', registered: true })),
    );
    const result = await client.registerHostId();
    expect(result.hostId).toBe('');
  });

  test('falls back to empty string for user_id when field is not a string', async () => {
    const client = createClient(
      mockFetch(() => jsonResponse({ host_id: 'h_abc', user_id: null, registered: true })),
    );
    const result = await client.registerHostId();
    expect(result.userId).toBe('');
  });

  test('registered falls back to false when field is not boolean true', async () => {
    const client = createClient(
      mockFetch(() => jsonResponse({ host_id: 'h_abc', user_id: 'u_xyz', registered: 'yes' })),
    );
    const result = await client.registerHostId();
    expect(result.registered).toBe(false);
  });

  test('POSTs to the registerHostId endpoint with hostId in body', async () => {
    const log: MockCall[] = [];
    const client = createClient(
      mockFetch(() => jsonResponse({ host_id: 'h_test', user_id: 'u_xyz', registered: true }), log),
    );
    await client.registerHostId();
    expect(requireDefined(log[0]).url).toBe(endpoints.registerHostId);
    expect(requireDefined(log[0]).init.method).toBe('POST');
    const body = JSON.parse(requireDefined(log[0]).init.body as string);
    expect(body.host_id).toBe('h_test');
  });

  test('sends X-API-Key header', async () => {
    const log: MockCall[] = [];
    const client = createClient(
      mockFetch(() => jsonResponse({ host_id: 'h_test', user_id: 'u_xyz', registered: true }), log),
    );
    await client.registerHostId();
    const headers = requireDefined(log[0]).init.headers as Record<string, string>;
    expect(headers['X-API-Key']).toBe('pxg-20260505-secret');
  });

  test('throws NetworkError when fetch fails', async () => {
    const client = createClient(mockFetch(() => new Error('connection refused')));
    await expect(client.registerHostId()).rejects.toThrow(NetworkError);
  });
});

describe('fetchWatermarks', () => {
  test('returns parsed result with watermarks on 200', async () => {
    const client = createClient(
      mockFetch(() =>
        jsonResponse({
          host_id: 'h_abc',
          user_id: 'u_xyz',
          watermarks: [
            {
              source_app: 'claude-code',
              source_path_hash: VALID_SHA256,
              watermark_kind: 'byte_range',
              watermark_end: 4096,
              watermark_table: null,
            },
          ],
        }),
      ),
    );
    const result = await client.fetchWatermarks();
    expect(result.hostId).toBe('h_abc');
    expect(result.userId).toBe('u_xyz');
    expect(result.watermarks).toHaveLength(1);
    expect(result.watermarks[0]?.sourceApp).toBe('claude-code');
    expect(result.watermarks[0]?.sourcePathHash).toBe(VALID_SHA256);
    expect(result.watermarks[0]?.watermarkKind).toBe('byte_range');
    expect(result.watermarks[0]?.watermarkEnd).toBe(4096);
    expect(result.watermarks[0]?.watermarkTable).toBeNull();
  });

  test('returns watermark with non-null table', async () => {
    const client = createClient(
      mockFetch(() =>
        jsonResponse({
          host_id: 'h_abc',
          user_id: 'u_xyz',
          watermarks: [
            {
              source_app: 'cursor',
              source_path_hash: VALID_SHA256,
              watermark_kind: 'rowid_range',
              watermark_end: 100,
              watermark_table: 'ItemTable',
            },
          ],
        }),
      ),
    );
    const result = await client.fetchWatermarks();
    expect(result.watermarks[0]?.watermarkKind).toBe('rowid_range');
    expect(result.watermarks[0]?.watermarkTable).toBe('ItemTable');
  });

  test('skips malformed watermark items (missing required fields)', async () => {
    const client = createClient(
      mockFetch(() =>
        jsonResponse({
          host_id: 'h_abc',
          user_id: 'u_xyz',
          watermarks: [
            { source_app: 'claude-code' },
            {
              source_app: 'claude-code',
              source_path_hash: VALID_SHA256,
              watermark_kind: 'byte_range',
              watermark_end: 100,
              watermark_table: null,
            },
          ],
        }),
      ),
    );
    const result = await client.fetchWatermarks();
    expect(result.watermarks).toHaveLength(1);
    expect(result.watermarks[0]?.watermarkEnd).toBe(100);
  });

  test('returns empty watermarks array when watermarks field is not an array', async () => {
    const client = createClient(
      mockFetch(() => jsonResponse({ host_id: 'h_abc', user_id: 'u_xyz', watermarks: null })),
    );
    const result = await client.fetchWatermarks();
    expect(result.watermarks).toHaveLength(0);
  });

  test('returns empty watermarks array when watermarks field is absent', async () => {
    const client = createClient(
      mockFetch(() => jsonResponse({ host_id: 'h_abc', user_id: 'u_xyz' })),
    );
    const result = await client.fetchWatermarks();
    expect(result.watermarks).toHaveLength(0);
  });

  test('falls back to empty string for host_id when field is missing', async () => {
    const client = createClient(
      mockFetch(() => jsonResponse({ user_id: 'u_xyz', watermarks: [] })),
    );
    const result = await client.fetchWatermarks();
    expect(result.hostId).toBe('');
  });

  test('falls back to empty string for user_id when field is missing', async () => {
    const client = createClient(
      mockFetch(() => jsonResponse({ host_id: 'h_abc', watermarks: [] })),
    );
    const result = await client.fetchWatermarks();
    expect(result.userId).toBe('');
  });

  test('GETs the watermarks endpoint with host_id query param', async () => {
    const log: MockCall[] = [];
    const client = createClient(
      mockFetch(() => jsonResponse({ host_id: 'h_test', user_id: 'u_xyz', watermarks: [] }), log),
    );
    await client.fetchWatermarks();
    expect(requireDefined(log[0]).url).toBe(`${endpoints.watermarks}?host_id=h_test`);
    expect(requireDefined(log[0]).init.method).toBe('GET');
  });

  test('encodes special characters in host_id query param', async () => {
    const log: MockCall[] = [];
    const specialClient = new HttpClient({
      apiKey: 'pxg-20260505-secret',
      hostId: 'h test+1',
      endpoints,
      fetch: mockFetch(
        () => jsonResponse({ host_id: 'h test+1', user_id: 'u_xyz', watermarks: [] }),
        log,
      ),
    });
    await specialClient.fetchWatermarks();
    expect(requireDefined(log[0]).url).toContain('host_id=h%20test%2B1');
  });

  test('sends X-API-Key header', async () => {
    const log: MockCall[] = [];
    const client = createClient(
      mockFetch(() => jsonResponse({ host_id: 'h_test', user_id: 'u_xyz', watermarks: [] }), log),
    );
    await client.fetchWatermarks();
    const headers = requireDefined(log[0]).init.headers as Record<string, string>;
    expect(headers['X-API-Key']).toBe('pxg-20260505-secret');
  });

  test('throws NetworkError when fetch fails', async () => {
    const client = createClient(mockFetch(() => new Error('connection refused')));
    await expect(client.fetchWatermarks()).rejects.toThrow(NetworkError);
  });
});
