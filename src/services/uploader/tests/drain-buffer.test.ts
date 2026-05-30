import { requireDefined } from 'core/utils';
import type { FetchFn } from 'core/utils';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmRecursive } from 'core/io/fs';

import { getBatch, getReceipt, insertBatch, openInMemoryBufferDb } from 'services/buffer';
import { drainBuffer } from 'services/uploader';
import type { Pacer, UploaderContext } from 'services/uploader';
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

function ctxWith(fetchFn: FetchFn): UploaderContext {
  return { db, http: createTestHttpClient(fetchFn), hostId: TEST_HOST_ID };
}

async function insertN(count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const batch = newClaudeCodeBatch(`payload-${i.toString()}`, {
      watermarkStart: i * 100,
      watermarkEnd: (i + 1) * 100,
    });
    insertBatch(db, batch);
    ids.push(batch.captureId);
    await Bun.sleep(2);
  }
  return ids;
}

test('empty buffer returns zero attempts', async () => {
  const ctx = ctxWith(mockFetch(() => emptyResponse(200)));
  const result = await drainBuffer(ctx);
  expect(result.attempted).toBe(0);
  expect(result.accepted).toBe(0);
  expect(result.retriable).toBe(0);
  expect(result.fatal).toBe(0);
  expect(result.lastRetriableRetryAfterMs).toBeNull();
});

test('drains all pending batches when server accepts each', async () => {
  const ids = await insertN(3);
  const ctx = ctxWith(
    mockFetch((call) => {
      const parsed = JSON.parse(call.init.body as string);
      return jsonResponse({
        capture_id: parsed.capture_id,
        accepted: true,
        idempotent: false,
      });
    }),
  );
  const result = await drainBuffer(ctx);
  expect(result.attempted).toBe(3);
  expect(result.accepted).toBe(3);
  for (const id of ids) {
    expect(getBatch(db, id)).toBeNull();
    expect(getReceipt(db, id)).not.toBeNull();
  }
});

test('continues past intermittent retriable failures and resets consecutive counter on success', async () => {
  const ids = await insertN(5);
  let calls = 0;
  const ctx = ctxWith(
    mockFetch((call) => {
      calls++;
      if (calls === 2 || calls === 3) return emptyResponse(503);
      const parsed = JSON.parse(call.init.body as string);
      return jsonResponse({ capture_id: parsed.capture_id, accepted: true, idempotent: false });
    }),
  );
  const result = await drainBuffer(ctx);
  expect(result.attempted).toBe(5);
  expect(result.accepted).toBe(3);
  expect(result.retriable).toBe(2);
  expect(result.consecutiveRetriableBreak).toBe(false);
  expect(getBatch(db, requireDefined(ids[0]))).toBeNull();
  expect(getReceipt(db, requireDefined(ids[0]))).not.toBeNull();
});

test('breaks after DRAIN_MAX_CONSECUTIVE_RETRIABLE consecutive retriable failures', async () => {
  const ids = await insertN(6);
  const ctx = ctxWith(mockFetch(() => emptyResponse(503)));
  const result = await drainBuffer(ctx);
  expect(result.attempted).toBe(3);
  expect(result.retriable).toBe(3);
  expect(result.accepted).toBe(0);
  expect(result.consecutiveRetriableBreak).toBe(true);
  expect(result.lastUploadError).not.toBeNull();
  for (const id of ids) {
    expect(requireDefined(getBatch(db, id)).status).toBe('pending');
  }
});

test('honors maxConsecutiveRetriable option override', async () => {
  await insertN(5);
  const ctx = ctxWith(mockFetch(() => emptyResponse(503)));
  const result = await drainBuffer(ctx, { maxConsecutiveRetriable: 1 });
  expect(result.attempted).toBe(1);
  expect(result.retriable).toBe(1);
  expect(result.consecutiveRetriableBreak).toBe(true);
});

test('a successful batch resets the consecutive retriable counter', async () => {
  await insertN(7);
  let calls = 0;
  const ctx = ctxWith(
    mockFetch((call) => {
      calls++;
      if (calls === 1 || calls === 2) return emptyResponse(503);
      if (calls === 3) {
        const parsed = JSON.parse(call.init.body as string);
        return jsonResponse({ capture_id: parsed.capture_id, accepted: true, idempotent: false });
      }
      if (calls === 4 || calls === 5) return emptyResponse(503);
      const parsed = JSON.parse(call.init.body as string);
      return jsonResponse({ capture_id: parsed.capture_id, accepted: true, idempotent: false });
    }),
  );
  const result = await drainBuffer(ctx);
  expect(result.attempted).toBe(7);
  expect(result.accepted).toBe(3);
  expect(result.retriable).toBe(4);
  expect(result.consecutiveRetriableBreak).toBe(false);
});

test('a fatal outcome resets the consecutive retriable counter', async () => {
  await insertN(7);
  let calls = 0;
  const ctx = ctxWith(
    mockFetch((call) => {
      calls++;
      if (calls === 1 || calls === 2) return emptyResponse(503);
      if (calls === 3) return emptyResponse(400);
      if (calls === 4 || calls === 5) return emptyResponse(503);
      const parsed = JSON.parse(call.init.body as string);
      return jsonResponse({ capture_id: parsed.capture_id, accepted: true, idempotent: false });
    }),
  );
  const result = await drainBuffer(ctx);
  expect(result.attempted).toBe(7);
  expect(result.fatal).toBe(1);
  expect(result.retriable).toBe(4);
  expect(result.accepted).toBe(2);
  expect(result.consecutiveRetriableBreak).toBe(false);
});

test('continues past fatal outcomes', async () => {
  const ids = await insertN(3);
  let calls = 0;
  const ctx = ctxWith(
    mockFetch(() => {
      calls++;
      if (calls === 2) return emptyResponse(400);
      return jsonResponse({ capture_id: ids[calls - 1], accepted: true, idempotent: false });
    }),
  );
  const result = await drainBuffer(ctx);
  expect(result.attempted).toBe(3);
  expect(result.accepted).toBe(2);
  expect(result.fatal).toBe(1);
  expect(getBatch(db, requireDefined(ids[0]))).toBeNull();
  expect(getReceipt(db, requireDefined(ids[0]))).not.toBeNull();
  expect(requireDefined(getBatch(db, requireDefined(ids[1]))).status).toBe('failed');
  expect(getBatch(db, requireDefined(ids[2]))).toBeNull();
  expect(getReceipt(db, requireDefined(ids[2]))).not.toBeNull();
});

test('honors maxBatches cap', async () => {
  await insertN(5);
  const ctx = ctxWith(
    mockFetch((call) => {
      const parsed = JSON.parse(call.init.body as string);
      return jsonResponse({
        capture_id: parsed.capture_id,
        accepted: true,
        idempotent: false,
      });
    }),
  );
  const result = await drainBuffer(ctx, { maxBatches: 2 });
  expect(result.attempted).toBe(2);
  expect(result.accepted).toBe(2);
});

test('surfaces rate-limit retryAfterMs from the most recent retriable batch', async () => {
  await insertN(5);
  const ctx = ctxWith(mockFetch(() => emptyResponse(429, { 'Retry-After': '12' })));
  const result = await drainBuffer(ctx);
  expect(result.attempted).toBe(3);
  expect(result.retriable).toBe(3);
  expect(result.lastRetriableRetryAfterMs).toBe(12_000);
  expect(result.consecutiveRetriableBreak).toBe(true);
});

test('drains in oldest-first order', async () => {
  const ids = await insertN(3);
  const order: string[] = [];
  const ctx = ctxWith(
    mockFetch((call) => {
      const parsed = JSON.parse(call.init.body as string);
      order.push(parsed.capture_id);
      return jsonResponse({
        capture_id: parsed.capture_id,
        accepted: true,
        idempotent: false,
      });
    }),
  );
  await drainBuffer(ctx);
  expect(order).toEqual(ids);
});

interface RecordedAcquire {
  bytes: number;
}

interface PacerSpy {
  pacer: Pacer;
  acquires: RecordedAcquire[];
  retryAfters: number[];
  notify429Count: { value: number };
  serviceUnavailableCalls: Array<number | undefined>;
}

function makePacerSpy(): PacerSpy {
  const acquires: RecordedAcquire[] = [];
  const retryAfters: number[] = [];
  const notify429Count = { value: 0 };
  const serviceUnavailableCalls: Array<number | undefined> = [];
  const pacer: Pacer = {
    acquire: async (bytes: number) => {
      acquires.push({ bytes });
    },
    notifyRetryAfter: (ms: number) => {
      retryAfters.push(ms);
    },
    notify429: () => {
      notify429Count.value++;
    },
    notifyServiceUnavailable: (ms?: number) => {
      serviceUnavailableCalls.push(ms);
    },
    stop: () => {},
  };
  return { pacer, acquires, retryAfters, notify429Count, serviceUnavailableCalls };
}

test('pacer.acquire is called once per batch with the body byte length', async () => {
  await insertN(3);
  const spy = makePacerSpy();
  const ctx: UploaderContext = {
    db,
    http: createTestHttpClient(
      mockFetch((call) => {
        const parsed = JSON.parse(call.init.body as string);
        return jsonResponse({
          capture_id: parsed.capture_id,
          accepted: true,
          idempotent: false,
        });
      }),
    ),
    hostId: TEST_HOST_ID,
    pacer: spy.pacer,
  };
  await drainBuffer(ctx);
  expect(spy.acquires.length).toBe(3);
  for (const a of spy.acquires) {
    expect(a.bytes).toBeGreaterThan(0);
  }
});

test('rate-limited response triggers notifyRetryAfter and notify429 only', async () => {
  await insertN(5);
  const spy = makePacerSpy();
  const ctx: UploaderContext = {
    db,
    http: createTestHttpClient(mockFetch(() => emptyResponse(429, { 'Retry-After': '15' }))),
    hostId: TEST_HOST_ID,
    pacer: spy.pacer,
  };
  const result = await drainBuffer(ctx);
  expect(result.retriable).toBe(3);
  expect(spy.retryAfters).toEqual([15_000, 15_000, 15_000]);
  expect(spy.notify429Count.value).toBe(3);
  expect(spy.serviceUnavailableCalls).toEqual([]);
});

test('503 response triggers notifyServiceUnavailable, not notify429', async () => {
  await insertN(1);
  const spy = makePacerSpy();
  const ctx: UploaderContext = {
    db,
    http: createTestHttpClient(mockFetch(() => emptyResponse(503))),
    hostId: TEST_HOST_ID,
    pacer: spy.pacer,
  };
  const result = await drainBuffer(ctx);
  expect(result.retriable).toBe(1);
  expect(spy.retryAfters).toEqual([]);
  expect(spy.notify429Count.value).toBe(0);
  expect(spy.serviceUnavailableCalls).toEqual([undefined]);
});

test('503 with Retry-After threads the hint into notifyServiceUnavailable', async () => {
  await insertN(1);
  const spy = makePacerSpy();
  const ctx: UploaderContext = {
    db,
    http: createTestHttpClient(mockFetch(() => emptyResponse(503, { 'Retry-After': '20' }))),
    hostId: TEST_HOST_ID,
    pacer: spy.pacer,
  };
  const result = await drainBuffer(ctx);
  expect(result.retriable).toBe(1);
  expect(spy.retryAfters).toEqual([20_000]);
  expect(spy.notify429Count.value).toBe(0);
  expect(spy.serviceUnavailableCalls).toEqual([20_000]);
});

test('auth-unconfirmed retriable does not trigger any pacer distress signal', async () => {
  await insertN(1);
  const spy = makePacerSpy();

  const ctx: UploaderContext = {
    db,
    http: createTestHttpClient(
      mockFetch((call) => {
        if (call.url.includes('/ingestion/verify-key')) return emptyResponse(503);
        return emptyResponse(401);
      }),
    ),
    hostId: TEST_HOST_ID,
    pacer: spy.pacer,
  };
  const result = await drainBuffer(ctx);
  expect(result.retriable).toBe(1);
  expect(spy.retryAfters).toEqual([]);
  expect(spy.notify429Count.value).toBe(0);
  expect(spy.serviceUnavailableCalls).toEqual([]);
});

test('watermark regression returns recovered and drain counts it separately', async () => {
  const ids = await insertN(2);
  let calls = 0;
  const ctx = ctxWith(
    mockFetch((call) => {
      calls++;
      if (calls === 1) {
        const parsed = JSON.parse(call.init.body as string) as { source_path_hash: string };
        return jsonResponse(
          {
            error: 'watermark_regression',
            current_server_watermark_end: 9999,
            source_path_hash: parsed.source_path_hash,
          },
          400,
        );
      }
      const parsed = JSON.parse(call.init.body as string) as { capture_id: string };
      return jsonResponse({ capture_id: parsed.capture_id, accepted: true, idempotent: false });
    }),
  );
  const result = await drainBuffer(ctx);
  expect(result.recovered).toBe(1);
  expect(result.accepted).toBe(1);
  expect(result.attempted).toBe(2);

  expect(getBatch(db, requireDefined(ids[0]))).toBeNull();
  expect(getReceipt(db, requireDefined(ids[0]))).toBeNull();
  expect(getBatch(db, requireDefined(ids[1]))).toBeNull();
  expect(getReceipt(db, requireDefined(ids[1]))).not.toBeNull();
});

test('network failure retriable does not trigger any pacer distress signal', async () => {
  await insertN(1);
  const spy = makePacerSpy();
  const ctx: UploaderContext = {
    db,
    http: createTestHttpClient(mockFetch(() => new Error('connection refused'))),
    hostId: TEST_HOST_ID,
    pacer: spy.pacer,
  };
  const result = await drainBuffer(ctx);
  expect(result.retriable).toBe(1);
  expect(spy.retryAfters).toEqual([]);
  expect(spy.notify429Count.value).toBe(0);
  expect(spy.serviceUnavailableCalls).toEqual([]);
});

test('breaks out of the drainBuffer loop immediately on a fatal auth error', async () => {
  const dirAuth = await mkdtemp(join(tmpdir(), 'proxai-drain-auth-'));
  const sentinelPath = join(dirAuth, 'AUTH_FAILED');
  try {
    await insertN(3);
    let calls = 0;
    const ctx: UploaderContext = {
      db,
      http: createTestHttpClient(
        mockFetch(() => {
          calls++;
          return emptyResponse(403);
        }),
      ),
      hostId: TEST_HOST_ID,
      authFailedSentinelPath: sentinelPath,
    };

    const result = await drainBuffer(ctx);
    expect(result.attempted).toBe(1);
    expect(result.fatal).toBe(1);
    expect(result.accepted).toBe(0);
    expect(calls).toBe(1);
    expect(await Bun.file(sentinelPath).exists()).toBe(true);
  } finally {
    await rmRecursive(dirAuth);
  }
});

test('continues past fatal validation errors even when auth failed sentinel path is defined', async () => {
  await insertN(2);
  const dirAuth = await mkdtemp(join(tmpdir(), 'proxai-drain-val-'));
  const sentinelPath = join(dirAuth, 'AUTH_FAILED');
  try {
    const ctx = ctxWith(
      mockFetch(() => emptyResponse(400)), // ValidationError -> fatal, but no sentinel written
    );
    ctx.authFailedSentinelPath = sentinelPath;

    const result = await drainBuffer(ctx);
    expect(result.attempted).toBe(2);
    expect(result.fatal).toBe(2);
    expect(await Bun.file(sentinelPath).exists()).toBe(false);
  } finally {
    await rmRecursive(dirAuth);
  }
});

test('drainBuffer breaks early if AUTH_FAILED sentinel is already present before start', async () => {
  const dirAuth = await mkdtemp(join(tmpdir(), 'proxai-drain-auth-pre-'));
  const sentinelPath = join(dirAuth, 'AUTH_FAILED');
  try {
    await insertN(1);
    await require('services/polling/auth-failed-sentinel.ts').writeAuthFailedSentinel(
      sentinelPath,
      'pre-existing',
    );
    const ctx = {
      db,
      http: createTestHttpClient(mockFetch(() => emptyResponse(200))),
      hostId: TEST_HOST_ID,
      authFailedSentinelPath: sentinelPath,
    };
    const result = await drainBuffer(ctx);
    expect(result.attempted).toBe(0);
  } finally {
    await rmRecursive(dirAuth);
  }
});
