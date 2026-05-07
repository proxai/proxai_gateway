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

test('notifyServiceUnavailable() makes the next acquire wait the initial 30s', async () => {
  const clock = makeClock();
  const pacer = createPacer({
    maxBatchesPerSec: 100,
    maxBytesPerMinute: 100 * 1024 * 1024,
    now: clock.now,
    sleep: clock.sleep,
  });
  await pacer.acquire(100); // primes buckets
  pacer.notifyServiceUnavailable();
  await pacer.acquire(100);
  // First step is the hard-coded initial delay: 30s.
  expect(clock.sleeps).toContain(30_000);
});

test('consecutive notifyServiceUnavailable doubles up to the 5-minute cap', async () => {
  const clock = makeClock();
  const pacer = createPacer({
    maxBatchesPerSec: 100,
    maxBytesPerMinute: 100 * 1024 * 1024,
    now: clock.now,
    sleep: clock.sleep,
  });
  await pacer.acquire(100);
  pacer.notifyServiceUnavailable();
  await pacer.acquire(100); // step 1: 30s
  pacer.notifyServiceUnavailable();
  await pacer.acquire(100); // step 2: 60s
  pacer.notifyServiceUnavailable();
  await pacer.acquire(100); // step 3: 120s
  pacer.notifyServiceUnavailable();
  await pacer.acquire(100); // step 4: 240s
  pacer.notifyServiceUnavailable();
  await pacer.acquire(100); // step 5: would be 480s, capped at 300s
  pacer.notifyServiceUnavailable();
  await pacer.acquire(100); // step 6: still capped at 300s
  expect(clock.sleeps).toContain(30_000);
  expect(clock.sleeps).toContain(60_000);
  expect(clock.sleeps).toContain(120_000);
  expect(clock.sleeps).toContain(240_000);
  expect(clock.sleeps).toContain(300_000);
  for (const s of clock.sleeps) expect(s).toBeLessThanOrEqual(300_000);
});

test('a non-503 acquire clears the service-unavailable streak', async () => {
  const clock = makeClock();
  const pacer = createPacer({
    maxBatchesPerSec: 100,
    maxBytesPerMinute: 100 * 1024 * 1024,
    now: clock.now,
    sleep: clock.sleep,
  });
  await pacer.acquire(100);
  pacer.notifyServiceUnavailable();
  await pacer.acquire(100); // step 1: 30s
  // No notify — caller observed a clean response. Streak should reset.
  await pacer.acquire(100);
  // Re-arm: should start back at step 1, not step 2.
  pacer.notifyServiceUnavailable();
  await pacer.acquire(100);
  // We expect TWO 30s sleeps (one before each promotion) and zero 60s sleeps
  // (which would only appear if the streak had escalated).
  const thirties = clock.sleeps.filter((s) => s === 30_000);
  expect(thirties.length).toBe(2);
  expect(clock.sleeps).not.toContain(60_000);
});

test('503 and 429 streaks are independent (do not compound)', async () => {
  const clock = makeClock();
  const pacer = createPacer({
    maxBatchesPerSec: 5,
    backoffMultiplier: 2,
    maxBytesPerMinute: 100 * 1024 * 1024,
    now: clock.now,
    sleep: clock.sleep,
  });
  await pacer.acquire(100);
  // 503, then 429, then 503 — none should escalate the other.
  pacer.notifyServiceUnavailable();
  await pacer.acquire(100); // 503 step 1: 30s
  pacer.notify429();
  await pacer.acquire(100); // 429 step 1: slot=200, 200*(2^1-1)=200ms
  pacer.notifyServiceUnavailable();
  await pacer.acquire(100); // 503 step 1 again (streak reset by interleaving): 30s
  // Both 503 backoffs should be 30s exactly (not 60s, which would imply the
  // streak survived the 429-only acquire).
  const thirties = clock.sleeps.filter((s) => s === 30_000);
  expect(thirties.length).toBe(2);
  // The 429 backoff slept 200ms.
  expect(clock.sleeps).toContain(200);
  // No 60s sleeps anywhere — that would only appear if either streak
  // escalated due to cross-contamination.
  expect(clock.sleeps).not.toContain(60_000);
});

test('explicit retryAfterMs raises the floor when larger than computed', async () => {
  const clock = makeClock();
  const pacer = createPacer({
    maxBatchesPerSec: 100,
    maxBytesPerMinute: 100 * 1024 * 1024,
    now: clock.now,
    sleep: clock.sleep,
  });
  await pacer.acquire(100);
  // Step 1 computed = 30s. Hint = 90s — server says wait longer.
  pacer.notifyServiceUnavailable(90_000);
  await pacer.acquire(100);
  // The 503 backoff specifically should be 90s (the floor). Step 1 computed
  // 30s is dominated. Note the explicit Retry-After is also handled in step 2
  // of acquire — but it'd surface as a separate sleep call there.
  expect(clock.sleeps).toContain(90_000);
});

test('explicit retryAfterMs is ignored when smaller than computed', async () => {
  const clock = makeClock();
  const pacer = createPacer({
    maxBatchesPerSec: 100,
    maxBytesPerMinute: 100 * 1024 * 1024,
    now: clock.now,
    sleep: clock.sleep,
  });
  await pacer.acquire(100);
  // Get to step 3 (120s computed). Hint = 1s — too small to matter.
  pacer.notifyServiceUnavailable();
  await pacer.acquire(100);
  pacer.notifyServiceUnavailable();
  await pacer.acquire(100);
  pacer.notifyServiceUnavailable(1_000);
  await pacer.acquire(100);
  // Final 503 backoff sleep should be 120s, not 1s.
  expect(clock.sleeps).toContain(120_000);
});

test('notifyServiceUnavailable with non-finite retryAfterMs is ignored', async () => {
  const clock = makeClock();
  const pacer = createPacer({
    maxBatchesPerSec: 100,
    maxBytesPerMinute: 100 * 1024 * 1024,
    now: clock.now,
    sleep: clock.sleep,
  });
  await pacer.acquire(100);
  pacer.notifyServiceUnavailable(Number.POSITIVE_INFINITY);
  await pacer.acquire(100);
  // Falls back to the computed 30s — infinity is rejected.
  expect(clock.sleeps).toContain(30_000);
});

test('multiple notifyServiceUnavailable calls before acquire keep the largest floor', async () => {
  const clock = makeClock();
  const pacer = createPacer({
    maxBatchesPerSec: 100,
    maxBytesPerMinute: 100 * 1024 * 1024,
    now: clock.now,
    sleep: clock.sleep,
  });
  await pacer.acquire(100);
  pacer.notifyServiceUnavailable(40_000);
  pacer.notifyServiceUnavailable(120_000);
  pacer.notifyServiceUnavailable(50_000);
  await pacer.acquire(100);
  // Step 1 computed=30s; floor=120s wins.
  expect(clock.sleeps).toContain(120_000);
  expect(clock.sleeps).not.toContain(40_000);
  expect(clock.sleeps).not.toContain(50_000);
});
