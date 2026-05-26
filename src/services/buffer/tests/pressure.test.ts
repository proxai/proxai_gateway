import { requireDefined } from 'core/utils';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';

import {
  checkPendingPressure,
  getBatch,
  insertBatch,
  markBatchDelivered,
  markBatchFailed,
  openInMemoryBufferDb,
} from 'services/buffer';
import { newBatch } from 'services/buffer/tests/fixtures.ts';

let db: Database;

beforeEach(() => {
  db = openInMemoryBufferDb();
});

afterEach(() => {
  db.close();
});

test('empty buffer: pendingBytes 0, neither pause nor resume signal', () => {
  const result = checkPendingPressure({
    db,
    softPauseBytes: 1000,
    softResumeBytes: 500,
  });
  expect(result.pendingBytes).toBe(0);
  expect(result.shouldPause).toBe(false);

  expect(result.shouldResume).toBe(true);
});

test('pending under pause threshold: shouldPause is false', () => {
  insertBatch(db, newBatch({ body: new Uint8Array(100) }));
  const result = checkPendingPressure({
    db,
    softPauseBytes: 1000,
    softResumeBytes: 500,
  });
  expect(result.pendingBytes).toBe(100);
  expect(result.shouldPause).toBe(false);
});

test('pending strictly above pause threshold: shouldPause is true', () => {
  insertBatch(db, newBatch({ body: new Uint8Array(1500) }));
  const result = checkPendingPressure({
    db,
    softPauseBytes: 1000,
    softResumeBytes: 500,
  });
  expect(result.pendingBytes).toBe(1500);
  expect(result.shouldPause).toBe(true);
});

test('pending exactly equal to pause threshold: shouldPause is false (strict greater-than)', () => {
  insertBatch(db, newBatch({ body: new Uint8Array(1000) }));
  const result = checkPendingPressure({
    db,
    softPauseBytes: 1000,
    softResumeBytes: 500,
  });
  expect(result.shouldPause).toBe(false);
});

test('hysteresis: shouldResume only fires below resume threshold', () => {
  insertBatch(db, newBatch({ body: new Uint8Array(500) }));
  const equal = checkPendingPressure({
    db,
    softPauseBytes: 1000,
    softResumeBytes: 500,
  });
  expect(equal.shouldResume).toBe(false);

  insertBatch(db, newBatch({ body: new Uint8Array(200) }));
  const between = checkPendingPressure({
    db,
    softPauseBytes: 1000,
    softResumeBytes: 500,
  });
  expect(between.pendingBytes).toBe(700);
  expect(between.shouldPause).toBe(false);
  expect(between.shouldResume).toBe(false);
});

test('failed and delivered batches do not contribute to pending bytes', () => {
  const a = newBatch({ body: new Uint8Array(100) });
  const b = newBatch({ body: new Uint8Array(200) });
  const c = newBatch({ body: new Uint8Array(400) });
  insertBatch(db, a);
  insertBatch(db, b);
  insertBatch(db, c);
  markBatchFailed(db, a.captureId, 'oops');
  markBatchDelivered(db, requireDefined(getBatch(db, b.captureId)), { idempotentOnServer: false });

  const result = checkPendingPressure({
    db,
    softPauseBytes: 1000,
    softResumeBytes: 500,
  });
  expect(result.pendingBytes).toBe(400);
});
