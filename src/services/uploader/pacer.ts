// Token-bucket upload pacer.
//
// Two independent buckets gate every upload:
//   * a per-second batch counter (default 5/s), and
//   * a per-minute byte counter (default 50 MiB/min).
// Both must allow the upload before acquire() returns. The pacer also honors
// explicit Retry-After delays from the server and applies a multiplicative
// backoff while consecutive 429 responses keep arriving.
//
// In addition to 429 backoff, the pacer tracks a separate streak for 503
// service-unavailable responses (nest backpressure). 503 backoff escalates
// from 30s to a 5-minute cap so the gateway does not pile on requests while
// nest's parse worker is recovering. The 503 and 429 streaks are independent
// — distinct distress signals shouldn't compound.

const DEFAULT_NOW = (): number => Date.now();
const DEFAULT_SLEEP = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const RATE_WINDOW_MS = 1_000;
const BYTES_WINDOW_MS = 60_000;
const MAX_BACKOFF_MS = 30_000;

// Service-unavailable (503) backoff envelope. Hard-coded because these are
// protocol-level — nest's parse-queue high-water-mark recovery time is not
// something a user should be tuning per-host.
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
  // Blocks until both the rate bucket and throughput bucket allow this batch
  // through, then debits them. Also honors any pending Retry-After delay and
  // 429/503 backoff multipliers accumulated since the previous acquire.
  acquire(payloadBytes: number): Promise<void>;
  // Forces a one-shot wait before the next acquire returns. The longest
  // pending wait wins if multiple Retry-Afters arrive before acquire runs.
  notifyRetryAfter(retryAfterMs: number): void;
  // Multiplies the per-batch slot for the next acquire. Cleared by the next
  // non-429 acquire (signalled implicitly: an acquire that is not preceded by
  // another notify429() resets the streak after running).
  notify429(): void;
  // Queues a 503 backoff step. The next acquire promotes it to an active
  // backoff: delay = min(30s * 2^(steps-1), 5min). Optional retryAfterMs
  // raises the floor to max(retryAfterMs, computed). Streak resets on the
  // first acquire that runs without a pending notifyServiceUnavailable.
  // Independent from the 429 streak (different fault class).
  notifyServiceUnavailable(retryAfterMs?: number): void;
}

interface Bucket {
  capacity: number;
  tokens: number;
  // Tokens per millisecond, derived once.
  refillPerMs: number;
  lastRefill: number;
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

  // Pending Retry-After deadline (absolute, ms). Cleared once consumed.
  let retryAfterUntil = 0;
  // Consecutive-429 streak. Each notify429() bumps it; the first acquire that
  // observes the bumped value applies the backoff. After the acquire runs, if
  // no further notify429() arrived, the streak resets to zero.
  let backoffSteps = 0;
  let pendingNotify429 = false;
  // Consecutive-503 streak. Tracked independently of the 429 streak so a
  // 503-then-429 sequence doesn't compound. Each notifyServiceUnavailable()
  // bumps the pending flag (and may raise a per-step floor via retryAfter);
  // the next acquire promotes it to an active backoff, then the streak resets
  // unless another notifyServiceUnavailable() arrived in the interim.
  let serviceUnavailableSteps = 0;
  let pendingServiceUnavailable = false;
  let pendingServiceUnavailableFloorMs = 0;

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

  async function acquire(payloadBytes: number): Promise<void> {
    if (payloadBytes < 0) throw new Error('payloadBytes must be >= 0');

    // 1) Promote a pending notify429() to an active backoff step. If no
    //    notify429() arrived since the previous acquire, the caller observed
    //    a non-429 outcome — reset the streak.
    if (pendingNotify429) {
      backoffSteps = Math.min(backoffSteps + 1, 16);
      pendingNotify429 = false;
    } else {
      backoffSteps = 0;
    }

    // 1b) Same promotion logic for the independent 503 streak. The floor (if
    //     any) is consumed alongside the streak step.
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

    // 2) Honor any pending explicit Retry-After.
    const t0 = now();
    if (retryAfterUntil > t0) {
      const wait = retryAfterUntil - t0;
      retryAfterUntil = 0;
      await sleep(wait);
    } else if (retryAfterUntil > 0) {
      retryAfterUntil = 0;
    }

    // 3) Apply the 429 backoff multiplier (one extra wait above the bucket
    //    refill cadence).
    if (backoffSteps > 0) {
      const slotMs = RATE_WINDOW_MS / rateBucket.capacity;
      const backoffBase = slotMs * (backoffMultiplier ** backoffSteps - 1);
      const backoff = Math.min(MAX_BACKOFF_MS, Math.ceil(backoffBase));
      if (backoff > 0) await sleep(backoff);
    }

    // 3b) Apply the 503 backoff. Computed envelope is 30s -> 60s -> 120s ...
    //     up to a 5-minute cap. If the server provided a Retry-After hint,
    //     raise the floor (max wins). Note the explicit Retry-After header
    //     was already consumed in step 2; the per-step floor here exists to
    //     guarantee the *backoff* itself meets the server hint even if the
    //     header was small or arrived before this streak was promoted.
    if (serviceUnavailableSteps > 0) {
      const computed = SERVICE_UNAVAILABLE_INITIAL_DELAY_MS * 2 ** (serviceUnavailableSteps - 1);
      const capped = Math.min(SERVICE_UNAVAILABLE_MAX_DELAY_MS, computed);
      const wait = Math.max(capped, serviceUnavailableFloorMs);
      if (wait > 0) await sleep(wait);
    }

    // 4) Wait until both buckets allow this batch, then debit.
    while (true) {
      const t = now();
      const needBytes = Math.min(payloadBytes, bytesBucket.capacity);
      const waitRate = timeUntil(rateBucket, 1, t);
      const waitBytes = needBytes > 0 ? timeUntil(bytesBucket, needBytes, t) : 0;
      const wait = Math.max(waitRate, waitBytes);
      if (wait <= 0) {
        debit(rateBucket, 1, t);
        if (needBytes > 0) debit(bytesBucket, needBytes, t);
        break;
      }
      await sleep(wait);
    }
  }

  function notifyRetryAfter(retryAfterMs: number): void {
    if (!Number.isFinite(retryAfterMs) || retryAfterMs <= 0) return;
    const target = now() + retryAfterMs;
    if (target > retryAfterUntil) retryAfterUntil = target;
  }

  function notify429(): void {
    pendingNotify429 = true;
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
  }

  return { acquire, notifyRetryAfter, notify429, notifyServiceUnavailable };
}
