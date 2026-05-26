import { createActor } from 'xstate';
import { pacerMachine } from 'services/state-machines/pacer';

const DEFAULT_NOW = (): number => Date.now();
const DEFAULT_SLEEP = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const RATE_WINDOW_MS = 1_000;
const BYTES_WINDOW_MS = 60_000;
const MAX_BACKOFF_MS = 30_000;

const SERVICE_UNAVAILABLE_INITIAL_DELAY_MS = 30_000;
const SERVICE_UNAVAILABLE_MAX_DELAY_MS = 300_000;

export interface PacerOptions {
  maxBatchesPerSec: number;
  maxBytesPerMinute: number;
  backoffMultiplier?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface Pacer {
  acquire(payloadBytes: number): Promise<void>;

  notifyRetryAfter(retryAfterMs: number): void;

  notify429(): void;

  notifyServiceUnavailable(retryAfterMs?: number): void;

  stop(): void;
}

interface Bucket {
  capacity: number;
  tokens: number;

  refillPerMs: number;
  lastRefill: number;
}

function refill(bucket: Bucket, t: number): void {
  if (t <= bucket.lastRefill) return;
  const elapsed = t - bucket.lastRefill;
  const refilled = elapsed * bucket.refillPerMs;
  bucket.tokens = Math.min(bucket.capacity, bucket.tokens + refilled);
  bucket.lastRefill = t;
}

function timeUntil(bucket: Bucket, need: number, t: number): number {
  refill(bucket, t);
  if (bucket.tokens >= need) return 0;
  const deficit = need - bucket.tokens;
  return Math.ceil(deficit / bucket.refillPerMs);
}

function debit(bucket: Bucket, amount: number, t: number): void {
  refill(bucket, t);
  bucket.tokens = Math.max(0, bucket.tokens - amount);
}

export function createPacer(options: PacerOptions): Pacer {
  if (options.maxBatchesPerSec <= 0) {
    throw new Error('maxBatchesPerSec must be > 0');
  }
  if (options.maxBytesPerMinute <= 0) {
    throw new Error('maxBytesPerMinute must be > 0');
  }
  const backoffMultiplier = options.backoffMultiplier ?? 2;
  const now = options.now ?? DEFAULT_NOW;
  const sleep = options.sleep ?? DEFAULT_SLEEP;

  const startedAt = now();
  const rateBucket: Bucket = {
    capacity: options.maxBatchesPerSec,
    tokens: options.maxBatchesPerSec,
    refillPerMs: options.maxBatchesPerSec / RATE_WINDOW_MS,
    lastRefill: startedAt,
  };
  const bytesBucket: Bucket = {
    capacity: options.maxBytesPerMinute,
    tokens: options.maxBytesPerMinute,
    refillPerMs: options.maxBytesPerMinute / BYTES_WINDOW_MS,
    lastRefill: startedAt,
  };

  let retryAfterUntil = 0;

  let backoffSteps = 0;
  let pendingNotify429 = false;

  let serviceUnavailableSteps = 0;
  let pendingServiceUnavailable = false;
  let pendingServiceUnavailableFloorMs = 0;

  const machine = createActor(pacerMachine, {
    input: {
      maxBatchesPerSec: options.maxBatchesPerSec,
      maxBytesPerMinute: options.maxBytesPerMinute,
    },
  });
  machine.start();

  async function acquire(payloadBytes: number): Promise<void> {
    if (payloadBytes < 0) throw new Error('payloadBytes must be >= 0');
    machine.send({ type: 'ACQUIRE_STARTED', payloadBytes });

    if (pendingNotify429) {
      backoffSteps = Math.min(backoffSteps + 1, 16);
      pendingNotify429 = false;
    } else {
      backoffSteps = 0;
    }

    let serviceUnavailableFloorMs = 0;
    if (pendingServiceUnavailable) {
      serviceUnavailableSteps = Math.min(serviceUnavailableSteps + 1, 16);
      serviceUnavailableFloorMs = pendingServiceUnavailableFloorMs;
      pendingServiceUnavailable = false;
      pendingServiceUnavailableFloorMs = 0;
    } else {
      serviceUnavailableSteps = 0;
      pendingServiceUnavailableFloorMs = 0;
    }

    const t0 = now();
    if (retryAfterUntil > t0) {
      const wait = retryAfterUntil - t0;
      retryAfterUntil = 0;
      await sleep(wait);
    } else if (retryAfterUntil > 0) {
      retryAfterUntil = 0;
    }

    machine.send({ type: 'ENTER_429_BACKOFF' });
    if (backoffSteps > 0) {
      const slotMs = RATE_WINDOW_MS / rateBucket.capacity;
      const backoffBase = slotMs * (backoffMultiplier ** backoffSteps - 1);
      const backoff = Math.min(MAX_BACKOFF_MS, Math.ceil(backoffBase));
      if (backoff > 0) await sleep(backoff);
    }

    machine.send({ type: 'ENTER_5XX_BACKOFF' });
    if (serviceUnavailableSteps > 0) {
      const computed = SERVICE_UNAVAILABLE_INITIAL_DELAY_MS * 2 ** (serviceUnavailableSteps - 1);
      const capped = Math.min(SERVICE_UNAVAILABLE_MAX_DELAY_MS, computed);
      const wait = Math.max(capped, serviceUnavailableFloorMs);
      if (wait > 0) await sleep(wait);
    }

    machine.send({ type: 'ENTER_TOKEN_BUCKET' });
    while (true) {
      const t = now();
      const needBytes = Math.min(payloadBytes, bytesBucket.capacity);
      const waitRate = timeUntil(rateBucket, 1, t);
      const waitBytes = needBytes > 0 ? timeUntil(bytesBucket, needBytes, t) : 0;
      const wait = Math.max(waitRate, waitBytes);
      if (wait <= 0) {
        machine.send({ type: 'ENTER_DEBITING' });
        debit(rateBucket, 1, t);
        if (needBytes > 0) debit(bytesBucket, needBytes, t);
        machine.send({
          type: 'ACQUIRE_COMPLETE',
          rateTokens: rateBucket.tokens,
          bytesTokens: bytesBucket.tokens,
          debitedAtMs: t,
        });
        break;
      }
      await sleep(wait);
    }
  }

  function notifyRetryAfter(retryAfterMs: number): void {
    if (!Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return;
    const target = now() + retryAfterMs;
    if (target > retryAfterUntil) retryAfterUntil = target;
    machine.send({ type: 'NOTIFY_RETRY_AFTER', untilMs: target });
  }

  function notify429(): void {
    pendingNotify429 = true;
    machine.send({ type: 'NOTIFY_429' });
  }

  function notifyServiceUnavailable(retryAfterMs?: number): void {
    pendingServiceUnavailable = true;
    if (
      retryAfterMs !== undefined &&
      Number.isFinite(retryAfterMs) &&
      retryAfterMs > pendingServiceUnavailableFloorMs
    ) {
      pendingServiceUnavailableFloorMs = retryAfterMs;
    }
    machine.send({
      type: 'NOTIFY_5XX',
      floorMs: retryAfterMs !== undefined && Number.isFinite(retryAfterMs) ? retryAfterMs : 0,
    });
  }

  function stop(): void {
    machine.stop();
  }

  return { acquire, notifyRetryAfter, notify429, notifyServiceUnavailable, stop };
}
