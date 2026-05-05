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
  authValidate: 'https://api.example.com/v1/auth/validate',
  health: 'https://api.example.com/v1/health',
  latestVersion: 'https://api.example.com/v1/gateway/latest_version',
  allowedHosts: 'https://api.example.com/v1/api-keys',
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
    apiKey: 'pxg_test_key',
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

  test('sets Authorization header with bearer token', async () => {
    const log: MockCall[] = [];
    const client = createClient(
      mockFetch(
        () => jsonResponse({ capture_id: VALID_UUID, accepted: true, idempotent: false }),
        log,
      ),
    );
    await client.uploadRawRecord(validDto());
    const headers = log[0]!.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer pxg_test_key');
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

describe('validateApiKey', () => {
  test('returns parsed result on 200', async () => {
    const client = createClient(
      mockFetch(() => jsonResponse({ valid: true, account_email: 'a@b.co', error: null })),
    );
    const result = await client.validateApiKey();
    expect(result.valid).toBe(true);
    expect(result.accountEmail).toBe('a@b.co');
    expect(result.error).toBeNull();
  });

  test('sends api_key in body', async () => {
    const log: MockCall[] = [];
    const client = createClient(
      mockFetch(() => jsonResponse({ valid: true, account_email: 'a@b.co', error: null }), log),
    );
    await client.validateApiKey();
    const body = JSON.parse(log[0]!.init.body as string);
    expect(body.api_key).toBe('pxg_test_key');
  });

  test('throws AuthError on 403', async () => {
    const client = createClient(mockFetch(() => emptyResponse(403)));
    await expect(client.validateApiKey()).rejects.toThrow(AuthError);
  });
});

describe('pinAllowedHost', () => {
  test('PATCHes /v1/api-keys/<key>/allowed-hosts with host_id in body', async () => {
    const log: MockCall[] = [];
    const client = createClient(
      mockFetch(() => jsonResponse({ allowed_host_ids: ['h_test'] }), log),
    );
    const result = await client.pinAllowedHost();
    expect(result.allowedHostIds).toEqual(['h_test']);
    expect(log[0]!.init.method).toBe('PATCH');
    expect(log[0]!.url).toContain('pxg_test_key');
    expect(log[0]!.url).toContain('/allowed-hosts');
    const body = JSON.parse(log[0]!.init.body as string);
    expect(body.host_id).toBe('h_test');
  });

  test('encodes special characters in api key path segment', async () => {
    const log: MockCall[] = [];
    const client = new HttpClient({
      apiKey: 'pxg/key with space',
      hostId: 'h_test',
      endpoints,
      fetch: mockFetch(() => jsonResponse({ allowed_host_ids: [] }), log),
    });
    await client.pinAllowedHost();
    expect(log[0]!.url).toContain('pxg%2Fkey%20with%20space');
  });
});

describe('checkHealth', () => {
  test('returns parsed result on 200', async () => {
    const client = createClient(mockFetch(() => jsonResponse({ ok: true, version: '1.0.0' })));
    const result = await client.checkHealth();
    expect(result.ok).toBe(true);
    expect(result.version).toBe('1.0.0');
  });

  test('GETs the health endpoint', async () => {
    const log: MockCall[] = [];
    const client = createClient(mockFetch(() => jsonResponse({ ok: true, version: '1.0.0' }), log));
    await client.checkHealth();
    expect(log[0]!.url).toBe(endpoints.health);
    expect(log[0]!.init.method).toBe('GET');
  });
});

describe('checkLatestVersion', () => {
  test('returns parsed and translated result', async () => {
    const client = createClient(
      mockFetch(() => jsonResponse({ latest_version: '1.0.0', release_date: '2026-04-29' })),
    );
    const result = await client.checkLatestVersion();
    expect(result.latestVersion).toBe('1.0.0');
    expect(result.releaseDate).toBe('2026-04-29');
  });
});

describe('error response parsing', () => {
  test('throws FatalError on unparseable 200 body', async () => {
    const client = createClient(mockFetch(() => new Response('not json', { status: 200 })));
    await expect(client.checkHealth()).rejects.toThrow(FatalError);
  });

  test('throws FatalError on empty 200 body', async () => {
    const client = createClient(mockFetch(() => emptyResponse(200)));
    await expect(client.checkHealth()).rejects.toThrow(FatalError);
  });
});
