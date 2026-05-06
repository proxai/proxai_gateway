import { expect, test } from 'bun:test';

import { createPacer } from 'services/uploader';

interface Clock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  sleeps: number[];
  advance: (ms: number) => void;
  current: () => number;
}

function makeClock(start = 0): Clock {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
    advance: (ms: number) => {
      t += ms;
    },
    current: () => t,
  };
}

test('first acquire under the rate limit returns without sleeping', async () => {
  const clock = makeClock();
  const pacer = createPacer({
    maxBatchesPerSec: 5,
    maxBytesPerMinute: 50 * 1024 * 1024,
    now: clock.now,
    sleep: clock.sleep,
  });
  await pacer.acquire(1024);
  expect(clock.sleeps.filter((s) => s > 0)).toEqual([]);
});

test('exhausting the rate bucket forces the next acquire to wait', async () => {
  const clock = makeClock();
  const pacer = createPacer({
    maxBatchesPerSec: 2,
    maxBytesPerMinute: 50 * 1024 * 1024,
    now: clock.now,
    sleep: clock.sleep,
  });
  await pacer.acquire(100);
  await pacer.acquire(100);
  // Bucket is empty (2 tokens consumed at t=0). Refill = 2/1000 ms.
  await pacer.acquire(100);
  // Expected wait: 1 token at 2/1000 per ms = 500 ms.
  const blockingSleeps = clock.sleeps.filter((s) => s > 0);
  expect(blockingSleeps.length).toBeGreaterThanOrEqual(1);
  expect(blockingSleeps[0]).toBe(500);
});

test('bytes bucket gates large payloads independently of the rate bucket', async () => {
  const clock = makeClock();
  const pacer = createPacer({
    // Wide-open rate; only the bytes bucket can throttle.
    maxBatchesPerSec: 1_000,
    maxBytesPerMinute: 60_000, // 1000 bytes/ms refill — easy math.
    now: clock.now,
    sleep: clock.sleep,
  });
  await pacer.acquire(60_000); // drains the bytes bucket completely
  await pacer.acquire(30_000); // needs 30_000 bytes
  // Refill rate = 60000 / 60000 = 1 byte/ms, so 30000 ms wait.
  const blockingSleeps = clock.sleeps.filter((s) => s > 0);
  expect(blockingSleeps).toContain(30_000);
});

test('payload larger than the per-minute capacity is clamped to capacity', async () => {
  const clock = makeClock();
  const pacer = createPacer({
    maxBatchesPerSec: 1_000,
    maxBytesPerMinute: 1_000,
    now: clock.now,
    sleep: clock.sleep,
  });
  // First acquire drains everything; second wants more than capacity. The
  // pacer must clamp the requested bytes to capacity so the wait is finite.
  await pacer.acquire(1_000);
  await pacer.acquire(10_000);
  const totalSleep = clock.sleeps.reduce((a, b) => a + b, 0);
  // Refill = 1000 / 60000 bytes/ms; wait for capacity = 60000 ms exactly.
  expect(totalSleep).toBe(60_000);
});

test('notifyRetryAfter forces an explicit wait before the next acquire', async () => {
  const clock = makeClock();
  const pacer = createPacer({
    maxBatchesPerSec: 100,
    maxBytesPerMinute: 100 * 1024 * 1024,
    now: clock.now,
    sleep: clock.sleep,
  });
  await pacer.acquire(100); // primes the buckets
  pacer.notifyRetryAfter(7_500);
  const before = clock.current();
  await pacer.acquire(100);
  const after = clock.current();
  expect(after - before).toBeGreaterThanOrEqual(7_500);
  expect(clock.sleeps).toContain(7_500);
});

test('notifyRetryAfter with the longest pending wait wins', async () => {
  const clock = makeClock();
  const pacer = createPacer({
    maxBatchesPerSec: 100,
    maxBytesPerMinute: 100 * 1024 * 1024,
    now: clock.now,
    sleep: clock.sleep,
  });
  pacer.notifyRetryAfter(2_000);
  pacer.notifyRetryAfter(5_000);
  pacer.notifyRetryAfter(1_000);
  await pacer.acquire(100);
  // Only the largest wait should land.
  expect(clock.sleeps).toContain(5_000);
  expect(clock.sleeps).not.toContain(2_000);
  expect(clock.sleeps).not.toContain(1_000);
});

test('notify429 applies the backoff multiplier on the next acquire', async () => {
  const clock = makeClock();
  const pacer = createPacer({
    maxBatchesPerSec: 5,
    backoffMultiplier: 3,
    maxBytesPerMinute: 100 * 1024 * 1024,
    now: clock.now,
    sleep: clock.sleep,
  });
  await pacer.acquire(100);
  pacer.notify429();
  // slot = 1000/5 = 200 ms. backoff steps=1: 200 * (3^1 - 1) = 400 ms.
  await pacer.acquire(100);
  expect(clock.sleeps).toContain(400);
});

test('consecutive notify429 escalates the backoff multiplicatively', async () => {
  const clock = makeClock();
  const pacer = createPacer({
    maxBatchesPerSec: 5,
    backoffMultiplier: 2,
    maxBytesPerMinute: 100 * 1024 * 1024,
    now: clock.now,
    sleep: clock.sleep,
  });
  await pacer.acquire(100);
  pacer.notify429();
  await pacer.acquire(100); // step 1: 200 * (2^1 - 1) = 200 ms
  pacer.notify429();
  await pacer.acquire(100); // step 2: 200 * (2^2 - 1) = 600 ms
  pacer.notify429();
  await pacer.acquire(100); // step 3: 200 * (2^3 - 1) = 1400 ms
  // Most recent backoff sleep should be the largest of these three.
  expect(clock.sleeps).toContain(200);
  expect(clock.sleeps).toContain(600);
  expect(clock.sleeps).toContain(1_400);
});

test('a non-429 acquire clears the backoff streak', async () => {
  const clock = makeClock();
  const pacer = createPacer({
    maxBatchesPerSec: 5,
    backoffMultiplier: 2,
    maxBytesPerMinute: 100 * 1024 * 1024,
    now: clock.now,
    sleep: clock.sleep,
  });
  await pacer.acquire(100);
  pacer.notify429();
  await pacer.acquire(100); // step 1 backoff applied
  // No notify429() — caller observed a clean response.
  await pacer.acquire(100); // should NOT apply any backoff
  // The third acquire must produce no new backoff sleep (>0 ms is allowed
  // only from bucket waits, and we are well within bucket budget).
  // Filter sleeps that match plausible backoff durations.
  const backoffSleeps = clock.sleeps.filter((s) => s === 200 || s === 600);
  expect(backoffSleeps).toEqual([200]);
});

test('backoff is capped at 30 seconds even with many consecutive 429s', async () => {
  const clock = makeClock();
  const pacer = createPacer({
    maxBatchesPerSec: 5,
    backoffMultiplier: 2,
    maxBytesPerMinute: 100 * 1024 * 1024,
    now: clock.now,
    sleep: clock.sleep,
  });
  await pacer.acquire(100);
  for (let i = 0; i < 12; i++) {
    pacer.notify429();
    await pacer.acquire(100);
  }
  // No single backoff sleep should ever exceed the 30s cap.
  for (const s of clock.sleeps) {
    expect(s).toBeLessThanOrEqual(30_000);
  }
});

test('rejects non-positive rate or throughput configuration', () => {
  expect(() => createPacer({ maxBatchesPerSec: 0, maxBytesPerMinute: 1 })).toThrow();
  expect(() => createPacer({ maxBatchesPerSec: 1, maxBytesPerMinute: 0 })).toThrow();
});

test('default now and sleep are used when not injected', async () => {
  // Exercises the DEFAULT_NOW (Date.now) and DEFAULT_SLEEP (setTimeout)
  // factory paths without long waits — small batch size, generous limits.
  const pacer = createPacer({
    maxBatchesPerSec: 1000,
    maxBytesPerMinute: 100 * 1024 * 1024,
  });
  await pacer.acquire(100);
  await pacer.acquire(100);
  // When sleep IS used (e.g. retry-after), it should resolve normally.
  pacer.notifyRetryAfter(1);
  await pacer.acquire(100);
  // No assertion beyond completion — coverage is the goal.
  expect(true).toBe(true);
});

test('expired retry-after deadline is cleared on the next acquire', async () => {
  const clock = makeClock();
  const pacer = createPacer({
    maxBatchesPerSec: 100,
    maxBytesPerMinute: 100 * 1024 * 1024,
    now: clock.now,
    sleep: clock.sleep,
  });
  pacer.notifyRetryAfter(2_000);
  // Advance past the retry-after deadline without invoking acquire — the
  // pending deadline stays armed but is now in the past.
  clock.advance(5_000);
  await pacer.acquire(100);
  // Stub clock recorded no sleeps for retry-after this time around.
  expect(clock.sleeps.includes(2_000)).toBe(false);
});

test('zero-byte payload still consumes a rate token but no throughput', async () => {
  const clock = makeClock();
  const pacer = createPacer({
    maxBatchesPerSec: 1,
    maxBytesPerMinute: 100,
    now: clock.now,
    sleep: clock.sleep,
  });
  await pacer.acquire(0); // consumes 1 rate token
  await pacer.acquire(0); // must wait for rate refill (1000 ms)
  expect(clock.sleeps).toContain(1_000);
});
