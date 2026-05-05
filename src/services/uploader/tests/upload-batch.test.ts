import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';

import { getBatch, insertBatch, openInMemoryBufferDb } from 'services/buffer';
import { uploadBatch } from 'services/uploader';
import type { UploaderContext } from 'services/uploader';
import {
  createTestHttpClient,
  emptyResponse,
  jsonResponse,
  mockFetch,
  newClaudeCodeBatch,
  TEST_HOST_ID,
} from 'services/uploader/tests/fixtures.ts';

let db: Database;

beforeEach(() => {
  db = openInMemoryBufferDb();
});

afterEach(() => {
  db.close();
});

function ctxWith(fetchFn: typeof globalThis.fetch): UploaderContext {
  return { db, http: createTestHttpClient(fetchFn), hostId: TEST_HOST_ID };
}

test('accepted upload marks batch done and returns idempotent flag', async () => {
  const batch = newClaudeCodeBatch('payload');
  insertBatch(db, batch);
  const stored = getBatch(db, batch.captureId)!;

  const ctx = ctxWith(
    mockFetch(() =>
      jsonResponse({ capture_id: batch.captureId, accepted: true, idempotent: false }),
    ),
  );
  const outcome = await uploadBatch(ctx, stored);

  expect(outcome.kind).toBe('accepted');
  if (outcome.kind === 'accepted') {
    expect(outcome.captureId).toBe(batch.captureId);
    expect(outcome.idempotent).toBe(false);
  }
  expect(getBatch(db, batch.captureId)!.status).toBe('done');
});

test('propagates idempotent: true from server', async () => {
  const batch = newClaudeCodeBatch('payload');
  insertBatch(db, batch);
  const stored = getBatch(db, batch.captureId)!;

  const ctx = ctxWith(
    mockFetch(() =>
      jsonResponse({ capture_id: batch.captureId, accepted: true, idempotent: true }),
    ),
  );
  const outcome = await uploadBatch(ctx, stored);
  if (outcome.kind === 'accepted') expect(outcome.idempotent).toBe(true);
});

test('400 ValidationError marks batch failed (terminal)', async () => {
  const batch = newClaudeCodeBatch('payload');
  insertBatch(db, batch);
  const stored = getBatch(db, batch.captureId)!;

  const ctx = ctxWith(mockFetch(() => emptyResponse(400)));
  const outcome = await uploadBatch(ctx, stored);

  expect(outcome.kind).toBe('fatal');
  const row = getBatch(db, batch.captureId)!;
  expect(row.status).toBe('failed');
  expect(row.attempts).toBe(1);
  expect(row.lastError).not.toBeNull();
});

test('403 AuthError keeps batch pending (retriable)', async () => {
  const batch = newClaudeCodeBatch('payload');
  insertBatch(db, batch);
  const stored = getBatch(db, batch.captureId)!;

  const ctx = ctxWith(mockFetch(() => emptyResponse(403)));
  const outcome = await uploadBatch(ctx, stored);

  expect(outcome.kind).toBe('retriable');
  if (outcome.kind === 'retriable') expect(outcome.retryAfterMs).toBeNull();
  const row = getBatch(db, batch.captureId)!;
  expect(row.status).toBe('pending');
  expect(row.attempts).toBe(1);
});

test('429 RateLimitError surfaces retryAfterMs and stays pending', async () => {
  const batch = newClaudeCodeBatch('payload');
  insertBatch(db, batch);
  const stored = getBatch(db, batch.captureId)!;

  const ctx = ctxWith(mockFetch(() => emptyResponse(429, { 'Retry-After': '45' })));
  const outcome = await uploadBatch(ctx, stored);

  expect(outcome.kind).toBe('retriable');
  if (outcome.kind === 'retriable') expect(outcome.retryAfterMs).toBe(45_000);
  expect(getBatch(db, batch.captureId)!.status).toBe('pending');
});

test('503 RetriableError keeps batch pending', async () => {
  const batch = newClaudeCodeBatch('payload');
  insertBatch(db, batch);
  const stored = getBatch(db, batch.captureId)!;

  const ctx = ctxWith(mockFetch(() => emptyResponse(503)));
  const outcome = await uploadBatch(ctx, stored);

  expect(outcome.kind).toBe('retriable');
  expect(getBatch(db, batch.captureId)!.status).toBe('pending');
});

test('408 maps to ValidationError -> fatal', async () => {
  const batch = newClaudeCodeBatch('payload');
  insertBatch(db, batch);
  const stored = getBatch(db, batch.captureId)!;

  const ctx = ctxWith(mockFetch(() => emptyResponse(408)));
  const outcome = await uploadBatch(ctx, stored);

  expect(outcome.kind).toBe('fatal');
  expect(getBatch(db, batch.captureId)!.status).toBe('failed');
});

test('413 maps to ValidationError -> fatal', async () => {
  const batch = newClaudeCodeBatch('payload');
  insertBatch(db, batch);
  const stored = getBatch(db, batch.captureId)!;

  const ctx = ctxWith(mockFetch(() => emptyResponse(413)));
  const outcome = await uploadBatch(ctx, stored);

  expect(outcome.kind).toBe('fatal');
  expect(getBatch(db, batch.captureId)!.status).toBe('failed');
});

test('unexpected status maps to FatalError -> fatal', async () => {
  const batch = newClaudeCodeBatch('payload');
  insertBatch(db, batch);
  const stored = getBatch(db, batch.captureId)!;

  const ctx = ctxWith(mockFetch(() => emptyResponse(418)));
  const outcome = await uploadBatch(ctx, stored);

  expect(outcome.kind).toBe('fatal');
  expect(getBatch(db, batch.captureId)!.status).toBe('failed');
});

test('network failure -> retriable, pending, attempts++', async () => {
  const batch = newClaudeCodeBatch('payload');
  insertBatch(db, batch);
  const stored = getBatch(db, batch.captureId)!;

  const ctx = ctxWith(mockFetch(() => new Error('connection refused')));
  const outcome = await uploadBatch(ctx, stored);

  expect(outcome.kind).toBe('retriable');
  const row = getBatch(db, batch.captureId)!;
  expect(row.status).toBe('pending');
  expect(row.attempts).toBe(1);
});

test('build-dto failure on corrupt zstd body marks batch failed', async () => {
  const batch = newClaudeCodeBatch('payload', {
    body: new Uint8Array([0xff, 0xff, 0xff, 0xff]),
  });
  insertBatch(db, batch);
  const stored = getBatch(db, batch.captureId)!;

  const ctx = ctxWith(mockFetch(() => emptyResponse(200)));
  const outcome = await uploadBatch(ctx, stored);

  expect(outcome.kind).toBe('fatal');
  if (outcome.kind === 'fatal') expect(outcome.error).toContain('dto build failed');
  expect(getBatch(db, batch.captureId)!.status).toBe('failed');
});

test('uploaded body is base64-encoded recompressed payload', async () => {
  const batch = newClaudeCodeBatch('hello upload');
  insertBatch(db, batch);
  const stored = getBatch(db, batch.captureId)!;

  const seen: { body: string } = { body: '' };
  const ctx = ctxWith(
    mockFetch((call) => {
      const parsed = JSON.parse(call.init.body as string);
      seen.body = parsed.body;
      return jsonResponse({ capture_id: batch.captureId, accepted: true, idempotent: false });
    }),
  );
  await uploadBatch(ctx, stored);

  expect(seen.body).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  expect(seen.body.length).toBeGreaterThan(0);
});

test('host_id from context is sent on the wire', async () => {
  const batch = newClaudeCodeBatch('payload');
  insertBatch(db, batch);
  const stored = getBatch(db, batch.captureId)!;

  const seen: { hostId: string } = { hostId: '' };
  const ctx: UploaderContext = {
    db,
    http: createTestHttpClient(
      mockFetch((call) => {
        const parsed = JSON.parse(call.init.body as string);
        seen.hostId = parsed.host_id;
        return jsonResponse({ capture_id: batch.captureId, accepted: true, idempotent: false });
      }),
    ),
    hostId: 'h_override',
  };
  await uploadBatch(ctx, stored);
  expect(seen.hostId).toBe('h_override');
});

test('unknown thrown value (non-Error) is captured and marks batch failed', async () => {
  const batch = newClaudeCodeBatch('payload');
  insertBatch(db, batch);
  const stored = getBatch(db, batch.captureId)!;

  const ctx = ctxWith(mockFetch(() => jsonResponse({})));
  ctx.http.uploadRawRecord = (async () => {
    throw 'plain string thrown';
  }) as typeof ctx.http.uploadRawRecord;

  const outcome = await uploadBatch(ctx, stored);
  expect(outcome.kind).toBe('fatal');
  if (outcome.kind === 'fatal') expect(outcome.error).toContain('unknown error');
  expect(getBatch(db, batch.captureId)!.status).toBe('failed');
});

test('unknown error with a falsy message falls back to String(err)', async () => {
  const batch = newClaudeCodeBatch('payload');
  insertBatch(db, batch);
  const stored = getBatch(db, batch.captureId)!;

  const ctx = ctxWith(mockFetch(() => jsonResponse({})));
  ctx.http.uploadRawRecord = (async () => {
    throw { weird: true };
  }) as typeof ctx.http.uploadRawRecord;

  const outcome = await uploadBatch(ctx, stored);
  expect(outcome.kind).toBe('fatal');
  expect(getBatch(db, batch.captureId)!.status).toBe('failed');
});
