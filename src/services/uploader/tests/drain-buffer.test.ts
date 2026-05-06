import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';

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

function ctxWith(fetchFn: typeof globalThis.fetch): UploaderContext {
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
  expect(result.rateLimitedRetryAfterMs).toBeNull();
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

test('stops on first retriable outcome, leaves later batches pending', async () => {
  const ids = await insertN(3);
  let calls = 0;
  const ctx = ctxWith(
    mockFetch(() => {
      calls++;
      if (calls === 1) {
        return jsonResponse({ capture_id: ids[0], accepted: true, idempotent: false });
      }
      return emptyResponse(503);
    }),
  );
  const result = await drainBuffer(ctx);
  expect(result.attempted).toBe(2);
  expect(result.accepted).toBe(1);
  expect(result.retriable).toBe(1);
  expect(getBatch(db, ids[0]!)).toBeNull();
  expect(getReceipt(db, ids[0]!)).not.toBeNull();
  expect(getBatch(db, ids[1]!)!.status).toBe('pending');
  expect(getBatch(db, ids[2]!)!.status).toBe('pending');
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
  expect(getBatch(db, ids[0]!)).toBeNull();
  expect(getReceipt(db, ids[0]!)).not.toBeNull();
  expect(getBatch(db, ids[1]!)!.status).toBe('failed');
  expect(getBatch(db, ids[2]!)).toBeNull();
  expect(getReceipt(db, ids[2]!)).not.toBeNull();
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

test('surfaces rate-limit retryAfterMs from the stopping batch', async () => {
  await insertN(2);
  const ctx = ctxWith(mockFetch(() => emptyResponse(429, { 'Retry-After': '12' })));
  const result = await drainBuffer(ctx);
  expect(result.attempted).toBe(1);
  expect(result.retriable).toBe(1);
  expect(result.rateLimitedRetryAfterMs).toBe(12_000);
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
}

function makePacerSpy(): PacerSpy {
  const acquires: RecordedAcquire[] = [];
  const retryAfters: number[] = [];
  const notify429Count = { value: 0 };
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
  };
  return { pacer, acquires, retryAfters, notify429Count };
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

test('rate-limited response triggers notifyRetryAfter and notify429', async () => {
  await insertN(2);
  const spy = makePacerSpy();
  const ctx: UploaderContext = {
    db,
    http: createTestHttpClient(mockFetch(() => emptyResponse(429, { 'Retry-After': '15' }))),
    hostId: TEST_HOST_ID,
    pacer: spy.pacer,
  };
  const result = await drainBuffer(ctx);
  expect(result.retriable).toBe(1);
  expect(spy.retryAfters).toEqual([15_000]);
  expect(spy.notify429Count.value).toBe(1);
});

test('non-429 retriable failures do not trigger notify429', async () => {
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
});
