import { describe, expect, test } from 'bun:test';

import {
  AuthError,
  FatalError,
  NetworkError,
  RateLimitError,
  RetriableError,
  ValidationError,
} from 'core/utils';
import type { RawRecordDTO } from 'services/contract';
import { HttpClient } from 'services/http';
import type { HttpEndpoints } from 'services/http';

const VALID_UUID = '01943f5a-7b1c-7e92-9c01-a0f3b40d77e3';
const VALID_SHA256 = 'a'.repeat(64);

const endpoints: HttpEndpoints = {
  ingest: 'https://api.example.com/v1/raw_records',
  verifyKey: 'https://api.example.com/ingestion/verify-key',
  watermarks: 'https://api.example.com/v1/watermarks',
};

interface MockCall {
  url: string;
  init: RequestInit;
}

function mockFetch(
  responder: (call: MockCall) => Response | Promise<Response> | Error,
  log?: MockCall[],
): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const call: MockCall = { url, init: init ?? {} };
    log?.push(call);
    const result = await responder(call);
    if (result instanceof Error) throw result;
    return result;
  }) as typeof globalThis.fetch;
}

function createClient(fetchFn: typeof globalThis.fetch): HttpClient {
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

  test('throws AuthError on 403', async () => {
    const client = createClient(mockFetch(() => emptyResponse(403)));
    await expect(client.uploadRawRecord(validDto())).rejects.toThrow(AuthError);
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

  test('sends X-API-Key header on upload', async () => {
    const log: MockCall[] = [];
    const client = createClient(
      mockFetch(
        () => jsonResponse({ capture_id: VALID_UUID, accepted: true, idempotent: false }),
        log,
      ),
    );
    await client.uploadRawRecord(validDto());
    const headers = log[0]!.init.headers as Record<string, string>;
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
    const headers = log[0]!.init.headers as Record<string, string>;
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
    const body = JSON.parse(log[0]!.init.body as string);
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
    expect(log[0]!.url).toBe(endpoints.ingest);
    expect(log[0]!.init.method).toBe('POST');
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
    expect(log[0]!.url).toBe(endpoints.verifyKey);
    expect(log[0]!.init.method).toBe('GET');
    const headers = log[0]!.init.headers as Record<string, string>;
    expect(headers['X-API-Key']).toBe('pxg-20260505-secret');
  });

  test('throws AuthError on 403 (invalid or revoked key)', async () => {
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
