import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { rmRecursive } from 'core/io/fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OversizedDecompressedSliceError, requireDefined } from 'core/utils';
import {
  getBatch,
  getCursor,
  getReceipt,
  insertBatch,
  openInMemoryBufferDb,
} from 'services/buffer';
import { HttpClient, UPLOAD_TIMEOUT_MS } from 'services/http';
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

test('uploadRawRecord passes UPLOAD_TIMEOUT_MS to AbortSignal.timeout', async () => {
  const batch = newClaudeCodeBatch('payload');
  insertBatch(db, batch);
  const stored = requireDefined(getBatch(db, batch.captureId));
  const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
  const captured: number[] = [];
  (AbortSignal as { timeout: (ms: number) => AbortSignal }).timeout = (ms: number): AbortSignal => {
    captured.push(ms);
    return originalTimeout(ms);
  };
  try {
    const ctx = ctxWith(
      mockFetch(() =>
        jsonResponse({ capture_id: batch.captureId, accepted: true, idempotent: false }),
      ),
    );
    await uploadBatch(ctx, stored);
  } finally {
    (AbortSignal as { timeout: (ms: number) => AbortSignal }).timeout = originalTimeout;
  }
  expect(captured).toContain(UPLOAD_TIMEOUT_MS);
});

test('accepted upload writes receipt, deletes batch row, returns idempotent flag', async () => {
  const batch = newClaudeCodeBatch('payload');
  insertBatch(db, batch);
  const stored = requireDefined(getBatch(db, batch.captureId));

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
  expect(getBatch(db, batch.captureId)).toBeNull();
  const receipt = getReceipt(db, batch.captureId);
  expect(receipt).not.toBeNull();
  expect(requireDefined(receipt).sourceApp).toBe(stored.sourceApp);
  expect(requireDefined(receipt).sourcePathHash).toBe(stored.sourcePathHash);
  expect(requireDefined(receipt).watermarkKind).toBe(stored.watermarkKind);
  expect(requireDefined(receipt).watermarkStart).toBe(stored.watermarkStart);
  expect(requireDefined(receipt).watermarkEnd).toBe(stored.watermarkEnd);
  expect(requireDefined(receipt).watermarkTable).toBe(stored.watermarkTable);
  expect(requireDefined(receipt).idempotentOnServer).toBe(false);
});

test('propagates idempotent: true from server into receipt', async () => {
  const batch = newClaudeCodeBatch('payload');
  insertBatch(db, batch);
  const stored = requireDefined(getBatch(db, batch.captureId));

  const ctx = ctxWith(
    mockFetch(() =>
      jsonResponse({ capture_id: batch.captureId, accepted: true, idempotent: true }),
    ),
  );
  const outcome = await uploadBatch(ctx, stored);
  if (outcome.kind === 'accepted') expect(outcome.idempotent).toBe(true);
  expect(requireDefined(getReceipt(db, batch.captureId)).idempotentOnServer).toBe(true);
});

test('400 ValidationError marks batch failed (terminal)', async () => {
  const batch = newClaudeCodeBatch('payload');
  insertBatch(db, batch);
  const stored = requireDefined(getBatch(db, batch.captureId));

  const ctx = ctxWith(mockFetch(() => emptyResponse(400)));
  const outcome = await uploadBatch(ctx, stored);

  expect(outcome.kind).toBe('fatal');
  const row = requireDefined(getBatch(db, batch.captureId));
  expect(row.status).toBe('failed');
  expect(row.attempts).toBe(1);
  expect(row.lastError).not.toBeNull();
});

test('400 watermark_regression updates cursor, drops batch, returns recovered', async () => {
  const batch = newClaudeCodeBatch('payload', { watermarkStart: 0, watermarkEnd: 100 });
  insertBatch(db, batch);
  const stored = requireDefined(getBatch(db, batch.captureId));

  const ctx = ctxWith(
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            error: 'watermark_regression',
            current_server_watermark_end: 5000,
            source_path_hash: stored.sourcePathHash,
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        ),
    ),
  );
  const outcome = await uploadBatch(ctx, stored);

  expect(outcome.kind).toBe('recovered');
  if (outcome.kind === 'recovered') {
    expect(outcome.captureId).toBe(batch.captureId);
  }

  expect(getBatch(db, batch.captureId)).toBeNull();

  expect(getReceipt(db, batch.captureId)).toBeNull();

  const cursor = getCursor(db, {
    sourceApp: stored.sourceApp,
    sourcePathHash: stored.sourcePathHash,
    sourceInode: stored.sourceInode,
    watermarkTable: stored.watermarkTable,
  });
  expect(cursor?.watermarkEnd).toBe(5000);
});

test('400 with non-regression body falls through to plain ValidationError -> fatal', async () => {
  const batch = newClaudeCodeBatch('payload');
  insertBatch(db, batch);
  const stored = requireDefined(getBatch(db, batch.captureId));

  const ctx = ctxWith(
    mockFetch(
      () =>
        new Response(JSON.stringify({ error: 'invalid_dto' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
    ),
  );
  const outcome = await uploadBatch(ctx, stored);
  expect(outcome.kind).toBe('fatal');
  expect(requireDefined(getBatch(db, batch.captureId)).status).toBe('failed');
});

test('403 AuthError + verify-key success keeps batch pending (transient)', async () => {
  const batch = newClaudeCodeBatch('payload');
  insertBatch(db, batch);
  const stored = requireDefined(getBatch(db, batch.captureId));

  const ctx = ctxWith(
    mockFetch((call) => {
      if (call.url.includes('/ingestion/verify-key')) {
        return jsonResponse({ success: true, data: { userId: 'u_test' }, message: 'ok' });
      }
      return emptyResponse(403);
    }),
  );
  const outcome = await uploadBatch(ctx, stored);

  expect(outcome.kind).toBe('retriable');
  if (outcome.kind === 'retriable') expect(outcome.retryAfterMs).toBeNull();
  const row = requireDefined(getBatch(db, batch.captureId));
  expect(row.status).toBe('pending');
  expect(row.attempts).toBe(1);
});

test('429 RateLimitError surfaces retryAfterMs, reason=rate_limit, stays pending', async () => {
  const batch = newClaudeCodeBatch('payload');
  insertBatch(db, batch);
  const stored = requireDefined(getBatch(db, batch.captureId));

  const ctx = ctxWith(mockFetch(() => emptyResponse(429, { 'Retry-After': '45' })));
  const outcome = await uploadBatch(ctx, stored);

  expect(outcome.kind).toBe('retriable');
  if (outcome.kind === 'retriable') {
    expect(outcome.retryAfterMs).toBe(45_000);
    expect(outcome.reason).toBe('rate_limit');
  }
  expect(requireDefined(getBatch(db, batch.captureId)).status).toBe('pending');
});

test('503 RetriableError carries reason=service_unavailable, stays pending', async () => {
  const batch = newClaudeCodeBatch('payload');
  insertBatch(db, batch);
  const stored = requireDefined(getBatch(db, batch.captureId));

  const ctx = ctxWith(mockFetch(() => emptyResponse(503)));
  const outcome = await uploadBatch(ctx, stored);

  expect(outcome.kind).toBe('retriable');
  if (outcome.kind === 'retriable') {
    expect(outcome.reason).toBe('service_unavailable');
    expect(outcome.retryAfterMs).toBeNull();
  }
  expect(requireDefined(getBatch(db, batch.captureId)).status).toBe('pending');
});

test('408 maps to ValidationError -> fatal', async () => {
  const batch = newClaudeCodeBatch('payload');
  insertBatch(db, batch);
  const stored = requireDefined(getBatch(db, batch.captureId));

  const ctx = ctxWith(mockFetch(() => emptyResponse(408)));
  const outcome = await uploadBatch(ctx, stored);

  expect(outcome.kind).toBe('fatal');
  expect(requireDefined(getBatch(db, batch.captureId)).status).toBe('failed');
});

test('413 maps to ValidationError -> fatal', async () => {
  const batch = newClaudeCodeBatch('payload');
  insertBatch(db, batch);
  const stored = requireDefined(getBatch(db, batch.captureId));

  const ctx = ctxWith(mockFetch(() => emptyResponse(413)));
  const outcome = await uploadBatch(ctx, stored);

  expect(outcome.kind).toBe('fatal');
  expect(requireDefined(getBatch(db, batch.captureId)).status).toBe('failed');
});

test('unexpected status maps to FatalError -> fatal', async () => {
  const batch = newClaudeCodeBatch('payload');
  insertBatch(db, batch);
  const stored = requireDefined(getBatch(db, batch.captureId));

  const ctx = ctxWith(mockFetch(() => emptyResponse(418)));
  const outcome = await uploadBatch(ctx, stored);

  expect(outcome.kind).toBe('fatal');
  expect(requireDefined(getBatch(db, batch.captureId)).status).toBe('failed');
});

test('network failure -> retriable, reason=network, pending, attempts++', async () => {
  const batch = newClaudeCodeBatch('payload');
  insertBatch(db, batch);
  const stored = requireDefined(getBatch(db, batch.captureId));

  const ctx = ctxWith(mockFetch(() => new Error('connection refused')));
  const outcome = await uploadBatch(ctx, stored);

  expect(outcome.kind).toBe('retriable');
  if (outcome.kind === 'retriable') {
    expect(outcome.reason).toBe('network');
    expect(outcome.retryAfterMs).toBeNull();
  }
  const row = requireDefined(getBatch(db, batch.captureId));
  expect(row.status).toBe('pending');
  expect(row.attempts).toBe(1);
});

test('AuthError + verify-key inconclusive -> retriable, reason=auth_unconfirmed', async () => {
  const batch = newClaudeCodeBatch('payload');
  insertBatch(db, batch);
  const stored = requireDefined(getBatch(db, batch.captureId));

  const ctx = ctxWith(
    mockFetch((call) => {
      if (call.url.includes('/ingestion/verify-key')) return emptyResponse(503);
      return emptyResponse(401);
    }),
  );
  const outcome = await uploadBatch(ctx, stored);
  expect(outcome.kind).toBe('retriable');
  if (outcome.kind === 'retriable') expect(outcome.reason).toBe('auth_unconfirmed');
});

test('AuthError + verify-key transient-success -> retriable, reason=auth_unconfirmed', async () => {
  const batch = newClaudeCodeBatch('payload');
  insertBatch(db, batch);
  const stored = requireDefined(getBatch(db, batch.captureId));

  const ctx = ctxWith(
    mockFetch((call) => {
      if (call.url.includes('/ingestion/verify-key')) {
        return jsonResponse({ success: true, data: { userId: 'u_test' }, message: 'ok' });
      }
      return emptyResponse(403);
    }),
  );
  const outcome = await uploadBatch(ctx, stored);
  expect(outcome.kind).toBe('retriable');
  if (outcome.kind === 'retriable') expect(outcome.reason).toBe('auth_unconfirmed');
});

test('uploaded body is base64-encoded recompressed payload', async () => {
  const batch = newClaudeCodeBatch('hello upload');
  insertBatch(db, batch);
  const stored = requireDefined(getBatch(db, batch.captureId));

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
  const stored = requireDefined(getBatch(db, batch.captureId));

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
  const stored = requireDefined(getBatch(db, batch.captureId));

  const ctx = ctxWith(mockFetch(() => jsonResponse({})));
  ctx.http.uploadRawRecord = (async () => {
    throw 'plain string thrown';
  }) as typeof ctx.http.uploadRawRecord;

  const outcome = await uploadBatch(ctx, stored);
  expect(outcome.kind).toBe('fatal');
  if (outcome.kind === 'fatal') expect(outcome.error).toContain('unknown error');
  expect(requireDefined(getBatch(db, batch.captureId)).status).toBe('failed');
});

test('unknown error with a falsy message falls back to String(err)', async () => {
  const batch = newClaudeCodeBatch('payload');
  insertBatch(db, batch);
  const stored = requireDefined(getBatch(db, batch.captureId));

  const ctx = ctxWith(mockFetch(() => jsonResponse({})));
  ctx.http.uploadRawRecord = (async () => {
    throw { weird: true };
  }) as typeof ctx.http.uploadRawRecord;

  const outcome = await uploadBatch(ctx, stored);
  expect(outcome.kind).toBe('fatal');
  expect(requireDefined(getBatch(db, batch.captureId)).status).toBe('failed');
});

test('AuthError + verify-key returns success: false → fatal, sentinel written', async () => {
  const dirAuth = await mkdtemp(join(tmpdir(), 'proxai-upload-auth-'));
  const sentinelPath = join(dirAuth, 'AUTH_FAILED');
  try {
    const batch = newClaudeCodeBatch('payload');
    insertBatch(db, batch);
    const stored = requireDefined(getBatch(db, batch.captureId));

    const ctx: UploaderContext = {
      db,
      http: createTestHttpClient(
        mockFetch((call) => {
          if (call.url.includes('/ingestion/verify-key')) {
            return jsonResponse({
              success: false,
              message: 'key expired',
              data: null,
            });
          }
          return emptyResponse(401);
        }),
      ),
      hostId: TEST_HOST_ID,
      authFailedSentinelPath: sentinelPath,
    };
    const outcome = await uploadBatch(ctx, stored);

    expect(outcome.kind).toBe('fatal');
    if (outcome.kind === 'fatal') expect(outcome.error).toContain('ingestion key invalid');
    const row = requireDefined(getBatch(db, batch.captureId));
    expect(row.status).toBe('failed');
    expect(await Bun.file(sentinelPath).exists()).toBe(true);
    const payload = JSON.parse(await Bun.file(sentinelPath).text()) as Record<string, unknown>;
    expect(payload['reason']).toBe('key expired');
    expect(typeof payload['detected_at']).toBe('string');
  } finally {
    await rmRecursive(dirAuth);
  }
});

test('AuthError + verify-key returns success: true → retriable, no sentinel', async () => {
  const dirAuth = await mkdtemp(join(tmpdir(), 'proxai-upload-auth-'));
  const sentinelPath = join(dirAuth, 'AUTH_FAILED');
  try {
    const batch = newClaudeCodeBatch('payload');
    insertBatch(db, batch);
    const stored = requireDefined(getBatch(db, batch.captureId));

    const ctx: UploaderContext = {
      db,
      http: createTestHttpClient(
        mockFetch((call) => {
          if (call.url.includes('/ingestion/verify-key')) {
            return jsonResponse({
              success: true,
              data: { userId: 'u_test', keyName: 'k' },
              message: 'ok',
            });
          }
          return emptyResponse(403);
        }),
      ),
      hostId: TEST_HOST_ID,
      authFailedSentinelPath: sentinelPath,
    };
    const outcome = await uploadBatch(ctx, stored);

    expect(outcome.kind).toBe('retriable');
    const row = requireDefined(getBatch(db, batch.captureId));
    expect(row.status).toBe('pending');
    expect(await Bun.file(sentinelPath).exists()).toBe(false);
  } finally {
    await rmRecursive(dirAuth);
  }
});

test('AuthError + verify-key throws RetriableError → retriable, no sentinel', async () => {
  const dirAuth = await mkdtemp(join(tmpdir(), 'proxai-upload-auth-'));
  const sentinelPath = join(dirAuth, 'AUTH_FAILED');
  try {
    const batch = newClaudeCodeBatch('payload');
    insertBatch(db, batch);
    const stored = requireDefined(getBatch(db, batch.captureId));

    const ctx: UploaderContext = {
      db,
      http: createTestHttpClient(
        mockFetch((call) => {
          if (call.url.includes('/ingestion/verify-key')) {
            return emptyResponse(503);
          }
          return emptyResponse(401);
        }),
      ),
      hostId: TEST_HOST_ID,
      authFailedSentinelPath: sentinelPath,
    };
    const outcome = await uploadBatch(ctx, stored);

    expect(outcome.kind).toBe('retriable');
    const row = requireDefined(getBatch(db, batch.captureId));
    expect(row.status).toBe('pending');
    expect(await Bun.file(sentinelPath).exists()).toBe(false);
  } finally {
    await rmRecursive(dirAuth);
  }
});

test('AuthError + verify-key throws AuthError → fatal, sentinel written', async () => {
  const dirAuth = await mkdtemp(join(tmpdir(), 'proxai-upload-auth-'));
  const sentinelPath = join(dirAuth, 'AUTH_FAILED');
  try {
    const batch = newClaudeCodeBatch('payload');
    insertBatch(db, batch);
    const stored = requireDefined(getBatch(db, batch.captureId));

    const ctx: UploaderContext = {
      db,
      http: createTestHttpClient(mockFetch(() => emptyResponse(403))),
      hostId: TEST_HOST_ID,
      authFailedSentinelPath: sentinelPath,
    };
    const outcome = await uploadBatch(ctx, stored);

    expect(outcome.kind).toBe('fatal');
    if (outcome.kind === 'fatal') expect(outcome.error).toContain('ingestion key invalid');
    expect(requireDefined(getBatch(db, batch.captureId)).status).toBe('failed');
    expect(await Bun.file(sentinelPath).exists()).toBe(true);
  } finally {
    await rmRecursive(dirAuth);
  }
});

test('AuthError + verify-key throws non-Error → retriable, log uses typeof and String(err)', async () => {
  const dirAuth = await mkdtemp(join(tmpdir(), 'proxai-upload-auth-'));
  const sentinelPath = join(dirAuth, 'AUTH_FAILED');
  try {
    const batch = newClaudeCodeBatch('payload');
    insertBatch(db, batch);
    const stored = requireDefined(getBatch(db, batch.captureId));

    const http = createTestHttpClient(mockFetch(() => emptyResponse(403)));
    Object.defineProperty(http, 'verifyKey', {
      value: async () => {
        throw 'string-thrown-not-error';
      },
    });

    const loggedErrors: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    const fakeLogger = {
      child: () => fakeLogger,
      fatal: () => undefined,
      error: (obj: Record<string, unknown>, msg: string) => {
        loggedErrors.push({ obj, msg });
      },
      warn: () => undefined,
      info: () => undefined,
      debug: () => undefined,
      trace: () => undefined,
    };

    const ctx: UploaderContext = {
      db,
      http,
      hostId: TEST_HOST_ID,
      authFailedSentinelPath: sentinelPath,
      logger: fakeLogger as unknown as NonNullable<UploaderContext['logger']>,
    };
    const outcome = await uploadBatch(ctx, stored);

    expect(outcome.kind).toBe('retriable');
    expect(requireDefined(getBatch(db, batch.captureId)).status).toBe('pending');
    expect(await Bun.file(sentinelPath).exists()).toBe(false);
    const inconclusive = loggedErrors.find((w) => w.msg.includes('verify-key inconclusive'));
    expect(inconclusive).toBeDefined();
    expect(inconclusive?.obj['kind']).toBe('string');
    expect(inconclusive?.obj['error']).toBe('string-thrown-not-error');
  } finally {
    await rmRecursive(dirAuth);
  }
});

test('AuthError + verify-key returns success: false → fatal even when sentinel write fails', async () => {
  const dirAuth = await mkdtemp(join(tmpdir(), 'proxai-upload-auth-fail-'));
  const fileBlocker = join(dirAuth, 'blocker');
  await Bun.write(fileBlocker, 'not-a-directory');
  const sentinelPath = join(fileBlocker, 'AUTH_FAILED');
  try {
    const batch = newClaudeCodeBatch('payload');
    insertBatch(db, batch);
    const stored = requireDefined(getBatch(db, batch.captureId));

    const http = createTestHttpClient(
      mockFetch((call) => {
        if (call.url.includes('/ingestion/verify-key')) {
          return jsonResponse({ success: false, message: 'revoked' });
        }
        return emptyResponse(401);
      }),
    );

    const loggedErrors: Array<{ obj: unknown; msg: string }> = [];
    const fakeLogger = {
      child: () => fakeLogger,
      fatal: () => undefined,
      error: (obj: unknown, msg: string) => {
        loggedErrors.push({ obj, msg });
      },
      warn: () => undefined,
      info: () => undefined,
      debug: () => undefined,
      trace: () => undefined,
    };

    const ctx: UploaderContext = {
      db,
      http,
      hostId: TEST_HOST_ID,
      authFailedSentinelPath: sentinelPath,
      logger: fakeLogger as unknown as NonNullable<UploaderContext['logger']>,
    };
    const outcome = await uploadBatch(ctx, stored);

    expect(outcome.kind).toBe('fatal');
    if (outcome.kind === 'fatal') expect(outcome.error).toContain('ingestion key invalid');
    expect(requireDefined(getBatch(db, batch.captureId)).status).toBe('failed');
    expect(loggedErrors.some((e) => e.msg.includes('failed to write AUTH_FAILED sentinel'))).toBe(
      true,
    );
  } finally {
    await rmRecursive(dirAuth);
  }
});

test('AuthError without authFailedSentinelPath: still classifies, no sentinel side-effect', async () => {
  const batch = newClaudeCodeBatch('payload');
  insertBatch(db, batch);
  const stored = requireDefined(getBatch(db, batch.captureId));

  const ctx: UploaderContext = {
    db,
    http: createTestHttpClient(mockFetch(() => emptyResponse(403))),
    hostId: TEST_HOST_ID,
  };
  const outcome = await uploadBatch(ctx, stored);

  expect(outcome.kind).toBe('fatal');
});

test('OversizedDecompressedSliceError thrown by http surfaces raw_bytes/cap/slice_index in fatal log', async () => {
  const batch = newClaudeCodeBatch('payload');
  insertBatch(db, batch);
  const stored = requireDefined(getBatch(db, batch.captureId));

  const oversize = new OversizedDecompressedSliceError({
    sourcePath: '/x.jsonl',
    sourcePathHash: 'h'.repeat(64),
    rawBytes: 11 * 1024 * 1024,
    compressedBytes: 1_800_000,
    sliceIndex: 2,
    cap: 10 * 1024 * 1024,
  });

  const fakeHttp = {
    uploadRawRecord: async () => {
      throw oversize;
    },
    verifyKey: async () => ({ success: true, message: '' }),
    fetchWatermarks: async () => [],
    registerHostId: async () => undefined,
  } as unknown as HttpClient;

  const loggedErrors: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  const fakeLogger = {
    child: () => fakeLogger,
    fatal: () => undefined,
    error: (obj: Record<string, unknown>, msg: string) => {
      loggedErrors.push({ obj, msg });
    },
    warn: () => undefined,
    info: () => undefined,
    debug: () => undefined,
    trace: () => undefined,
  };

  const ctx: UploaderContext = {
    db,
    http: fakeHttp,
    hostId: TEST_HOST_ID,
    logger: fakeLogger as unknown as NonNullable<UploaderContext['logger']>,
  };
  const outcome = await uploadBatch(ctx, stored);

  expect(outcome.kind).toBe('fatal');
  expect(requireDefined(getBatch(db, batch.captureId)).status).toBe('failed');
  const fatalLog = loggedErrors.find((e) => e.msg === 'upload failed (fatal)');
  expect(fatalLog).toBeDefined();
  expect(requireDefined(fatalLog).obj['raw_bytes']).toBe(11 * 1024 * 1024);
  expect(requireDefined(fatalLog).obj['cap']).toBe(10 * 1024 * 1024);
  expect(requireDefined(fatalLog).obj['slice_index']).toBe(2);
  expect(requireDefined(fatalLog).obj['source_path_hash']).toBe(stored.sourcePathHash);
  expect(requireDefined(fatalLog).obj['compressed_bytes']).toBe(stored.body.byteLength);
});
