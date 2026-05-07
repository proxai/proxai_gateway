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
  
  await pacer.acquire(100);
  
  const blockingSleeps = clock.sleeps.filter((s) => s > 0);
  expect(blockingSleeps.length).toBeGreaterThanOrEqual(1);
  expect(blockingSleeps[0]).toBe(500);
});

test('bytes bucket gates large payloads independently of the rate bucket', async () => {
  const clock = makeClock();
  const pacer = createPacer({
    
    maxBatchesPerSec: 1_000,
    maxBytesPerMinute: 60_000, 
    now: clock.now,
    sleep: clock.sleep,
  });
  await pacer.acquire(60_000); 
  await pacer.acquire(30_000); 
  
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
  
  
  await pacer.acquire(1_000);
  await pacer.acquire(10_000);
  const totalSleep = clock.sleeps.reduce((a, b) => a + b, 0);
  
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
  await pacer.acquire(100); 
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
  await pacer.acquire(100); 
  pacer.notify429();
  await pacer.acquire(100); 
  pacer.notify429();
  await pacer.acquire(100); 
  
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
  await pacer.acquire(100); 
  
  await pacer.acquire(100); 
  
  
  
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
  
  for (const s of clock.sleeps) {
    expect(s).toBeLessThanOrEqual(30_000);
  }
});

test('rejects non-positive rate or throughput configuration', () => {
  expect(() => createPacer({ maxBatchesPerSec: 0, maxBytesPerMinute: 1 })).toThrow();
  expect(() => createPacer({ maxBatchesPerSec: 1, maxBytesPerMinute: 0 })).toThrow();
});

test('default now and sleep are used when not injected', async () => {
  
  
  const pacer = createPacer({
    maxBatchesPerSec: 1000,
    maxBytesPerMinute: 100 * 1024 * 1024,
  });
  await pacer.acquire(100);
  await pacer.acquire(100);
  
  pacer.notifyRetryAfter(1);
  await pacer.acquire(100);
  
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
  
  
  clock.advance(5_000);
  await pacer.acquire(100);
  
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
  await pacer.acquire(0); 
  await pacer.acquire(0); 
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
  await pacer.acquire(100); 
  pacer.notifyServiceUnavailable();
  await pacer.acquire(100);
  
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
  await pacer.acquire(100); 
  pacer.notifyServiceUnavailable();
  await pacer.acquire(100); 
  pacer.notifyServiceUnavailable();
  await pacer.acquire(100); 
  pacer.notifyServiceUnavailable();
  await pacer.acquire(100); 
  pacer.notifyServiceUnavailable();
  await pacer.acquire(100); 
  pacer.notifyServiceUnavailable();
  await pacer.acquire(100); 
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
  await pacer.acquire(100); 
  
  await pacer.acquire(100);
  
  pacer.notifyServiceUnavailable();
  await pacer.acquire(100);
  
  
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
  
  pacer.notifyServiceUnavailable();
  await pacer.acquire(100); 
  pacer.notify429();
  await pacer.acquire(100); 
  pacer.notifyServiceUnavailable();
  await pacer.acquire(100); 
  
  
  const thirties = clock.sleeps.filter((s) => s === 30_000);
  expect(thirties.length).toBe(2);
  
  expect(clock.sleeps).toContain(200);
  
  
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
  
  pacer.notifyServiceUnavailable(90_000);
  await pacer.acquire(100);
  
  
  
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
  
  pacer.notifyServiceUnavailable();
  await pacer.acquire(100);
  pacer.notifyServiceUnavailable();
  await pacer.acquire(100);
  pacer.notifyServiceUnavailable(1_000);
  await pacer.acquire(100);
  
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
  
  expect(clock.sleeps).toContain(120_000);
  expect(clock.sleeps).not.toContain(40_000);
  expect(clock.sleeps).not.toContain(50_000);
});
