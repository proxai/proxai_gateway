import { generateUuidV7, zstdCompressSync } from 'core/utils';
import type { NewBatch } from 'services/buffer';
import { HttpClient } from 'services/http';
import type { HttpEndpoints } from 'services/http';

export const TEST_HOST_ID = 'h_test';
export const TEST_API_KEY = 'pxg_test_key';
export const TEST_GATEWAY_VERSION = '@proxai/gateway 0.1.0';

export const TEST_ENDPOINTS: HttpEndpoints = {
  ingest: 'https://api.example.com/v1/raw_records',
  health: 'https://api.example.com/health',
};

export interface MockCall {
  url: string;
  init: RequestInit;
}

export function mockFetch(
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

export function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (extraHeaders) Object.assign(headers, extraHeaders);
  return new Response(JSON.stringify(body), { status, headers });
}

export function emptyResponse(status: number, extraHeaders?: Record<string, string>): Response {
  const headers: Record<string, string> = {};
  if (extraHeaders) Object.assign(headers, extraHeaders);
  return new Response('', { status, headers });
}

export function createTestHttpClient(fetchFn: typeof globalThis.fetch): HttpClient {
  return new HttpClient({
    apiKey: TEST_API_KEY,
    hostId: TEST_HOST_ID,
    endpoints: TEST_ENDPOINTS,
    fetch: fetchFn,
  });
}

export function newClaudeCodeBatch(text: string, overrides: Partial<NewBatch> = {}): NewBatch {
  return {
    captureId: generateUuidV7(),
    sourceApp: 'claude-code',
    sourceKind: 'jsonl_append',
    sourcePath: '/Users/test/.claude/projects/x/session.jsonl',
    sourcePathHash: 'a'.repeat(64),
    sourceInode: 12345,
    watermarkKind: 'byte_range',
    watermarkStart: 0,
    watermarkEnd: text.length,
    watermarkTable: null,
    agentSchemaVersion: '2.1.122',
    gatewayVersion: TEST_GATEWAY_VERSION,
    capturedAtUtc: '2026-04-29T10:42:00.123Z',
    bodyFormat: 'jsonl',
    bodyCompression: 'zstd',
    body: zstdCompressSync(text),
    ...overrides,
  };
}

export function newCursorBatch(text: string, overrides: Partial<NewBatch> = {}): NewBatch {
  return {
    captureId: generateUuidV7(),
    sourceApp: 'cursor',
    sourceKind: 'sqlite_kv_snapshot',
    sourcePath: '/Users/test/Library/Application Support/Cursor/state.vscdb',
    sourcePathHash: 'b'.repeat(64),
    sourceInode: null,
    watermarkKind: 'rowid_range',
    watermarkStart: 0,
    watermarkEnd: 50,
    watermarkTable: null,
    agentSchemaVersion: '13:7',
    gatewayVersion: TEST_GATEWAY_VERSION,
    capturedAtUtc: '2026-04-29T10:42:00.123Z',
    bodyFormat: 'kv_pairs_json',
    bodyCompression: 'zstd',
    body: zstdCompressSync(text),
    ...overrides,
  };
}

export function newCodexStateBatch(text: string, overrides: Partial<NewBatch> = {}): NewBatch {
  return {
    captureId: generateUuidV7(),
    sourceApp: 'codex',
    sourceKind: 'sqlite_table_snapshot',
    sourcePath: '/Users/test/.codex/state_001.sqlite',
    sourcePathHash: 'c'.repeat(64),
    sourceInode: null,
    watermarkKind: 'rowid_range',
    watermarkStart: 0,
    watermarkEnd: 10,
    watermarkTable: 'threads',
    agentSchemaVersion: 'codex-1.2.3',
    gatewayVersion: TEST_GATEWAY_VERSION,
    capturedAtUtc: '2026-04-29T10:42:00.123Z',
    bodyFormat: 'sqlite_rows_json',
    bodyCompression: 'zstd',
    body: zstdCompressSync(text),
    ...overrides,
  };
}
