import { describe, expect, test } from 'bun:test';

import { AuthError, NetworkError, RetriableError, ValidationError } from 'core/utils';
import { HttpClient } from 'services/http';
import type { HttpEndpoints } from 'services/http';

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

function createClient(fetchFn: typeof globalThis.fetch, hostId = 'h_test'): HttpClient {
  return new HttpClient({
    apiKey: 'pxg-20260505-secret',
    hostId,
    endpoints,
    fetch: fetchFn,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('fetchWatermarks', () => {
  test('parses 200 response with watermarks array (snake_case → camelCase)', async () => {
    const client = createClient(
      mockFetch(() =>
        jsonResponse({
          host_id: 'h_test',
          user_id: 'u_1',
          watermarks: [
            {
              source_app: 'claude-code',
              source_path_hash: 'abc',
              watermark_kind: 'byte_range',
              watermark_end: 12345,
              watermark_table: null,
              last_delivered_at: '2026-04-29T10:42:00.123Z',
            },
            {
              source_app: 'codex',
              source_path_hash: 'def',
              watermark_kind: 'rowid_range',
              watermark_end: 50,
              watermark_table: 'threads',
              last_delivered_at: '2026-04-29T10:43:00.123Z',
            },
          ],
        }),
      ),
    );
    const result = await client.fetchWatermarks();
    expect(result.hostId).toBe('h_test');
    expect(result.userId).toBe('u_1');
    expect(result.watermarks).toHaveLength(2);
    expect(result.watermarks[0]).toEqual({
      sourceApp: 'claude-code',
      sourcePathHash: 'abc',
      watermarkKind: 'byte_range',
      watermarkEnd: 12345,
      watermarkTable: null,
      lastDeliveredAt: '2026-04-29T10:42:00.123Z',
    });
    expect(result.watermarks[1]?.watermarkTable).toBe('threads');
  });

  test('returns empty array when server reports no watermarks', async () => {
    const client = createClient(
      mockFetch(() => jsonResponse({ host_id: 'h_test', user_id: 'u_1', watermarks: [] })),
    );
    const result = await client.fetchWatermarks();
    expect(result.watermarks).toHaveLength(0);
  });

  test('drops malformed watermark entries silently', async () => {
    const client = createClient(
      mockFetch(() =>
        jsonResponse({
          host_id: 'h_test',
          user_id: 'u_1',
          watermarks: [
            {
              source_app: 'claude-code',
              source_path_hash: 'abc',
              watermark_kind: 'byte_range',
              watermark_end: 1,
              watermark_table: null,
              last_delivered_at: '2026-04-29T10:42:00Z',
            },
            { source_app: 'claude-code' }, 
            {
              source_app: 'claude-code',
              source_path_hash: 'xyz',
              watermark_kind: 'unknown_kind',
              watermark_end: 2,
              watermark_table: null,
              last_delivered_at: '2026-04-29T10:42:00Z',
            },
          ],
        }),
      ),
    );
    const result = await client.fetchWatermarks();
    expect(result.watermarks).toHaveLength(1);
    expect(result.watermarks[0]?.sourcePathHash).toBe('abc');
  });

  test('GETs watermarks endpoint with X-API-Key and host_id query param', async () => {
    const log: MockCall[] = [];
    const client = createClient(
      mockFetch(() => jsonResponse({ host_id: 'h_test', user_id: 'u_1', watermarks: [] }), log),
      'h_test',
    );
    await client.fetchWatermarks();
    expect(log[0]!.url).toBe(`${endpoints.watermarks}?host_id=h_test`);
    expect(log[0]!.init.method).toBe('GET');
    const headers = log[0]!.init.headers as Record<string, string>;
    expect(headers['X-API-Key']).toBe('pxg-20260505-secret');
  });

  test('url-encodes host_id query value', async () => {
    const log: MockCall[] = [];
    const client = createClient(
      mockFetch(() => jsonResponse({ host_id: 'h+special', user_id: 'u_1', watermarks: [] }), log),
      'h+special id',
    );
    await client.fetchWatermarks();
    expect(log[0]!.url).toContain('host_id=h%2Bspecial%20id');
  });

  test('throws AuthError on 401', async () => {
    const client = createClient(mockFetch(() => new Response('', { status: 401 })));
    await expect(client.fetchWatermarks()).rejects.toThrow(AuthError);
  });

  test('throws AuthError on 403', async () => {
    const client = createClient(mockFetch(() => new Response('', { status: 403 })));
    await expect(client.fetchWatermarks()).rejects.toThrow(AuthError);
  });

  test('throws RetriableError on 503', async () => {
    const client = createClient(mockFetch(() => new Response('', { status: 503 })));
    await expect(client.fetchWatermarks()).rejects.toThrow(RetriableError);
  });

  test('throws ValidationError on 400', async () => {
    const client = createClient(mockFetch(() => new Response('', { status: 400 })));
    await expect(client.fetchWatermarks()).rejects.toThrow(ValidationError);
  });

  test('throws NetworkError on fetch failure', async () => {
    const client = createClient(mockFetch(() => new Error('connection refused')));
    await expect(client.fetchWatermarks()).rejects.toThrow(NetworkError);
  });
});
