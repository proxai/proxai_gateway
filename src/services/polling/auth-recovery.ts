import { abortableSleep } from 'core/utils';
import type { MinimalLogger } from 'core/log';
import {
  clearAuthFailedSentinel,
  isAuthFailed,
  recordAuthRecoveryState,
} from 'services/polling/auth-failed-sentinel.ts';
import {
  AUTH_RECOVERY_BASE_MS,
  AUTH_RECOVERY_IDLE_MS,
  AUTH_RECOVERY_MAX_RETRIES,
} from 'services/polling/polling.constants.ts';

export interface AuthRecoveryContext {
  verifyKey: () => Promise<{ success: boolean }>;
  authFailedSentinelPath: string;
  logger?: MinimalLogger;
}

export interface AuthRecoveryOptions {
  baseDelayMs?: number;
  maxRetries?: number;
  idleMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  abortSignal?: AbortSignal | undefined;
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

/**
 * Self-healing AUTH_FAILED recovery loop. While the sentinel is present, it
 * re-verifies the gateway key on exponential backoff (1s, 2s, 4s, …). On the
 * first success it clears AUTH_FAILED so capture/drain auto-resume; after
 * `maxRetries` consecutive failures it marks the sentinel exhausted and stops
 * retrying until the sentinel is cleared externally (`setup new` / `dev setup`)
 * or the daemon restarts. Retry progress is persisted into the sentinel so the
 * status and doctor commands can surface the current trial number.
 */
export async function runAuthRecoveryLoop(
  ctx: AuthRecoveryContext,
  options: AuthRecoveryOptions = {},
): Promise<void> {
  const baseDelayMs = options.baseDelayMs ?? AUTH_RECOVERY_BASE_MS;
  const maxRetries = options.maxRetries ?? AUTH_RECOVERY_MAX_RETRIES;
  const idleMs = options.idleMs ?? AUTH_RECOVERY_IDLE_MS;
  const sleep = options.sleep ?? abortableSleep;
  const signal = options.abortSignal;

  let trial = 0;
  let lastError: string | null = null;

  while (!aborted(signal)) {
    if (!(await isAuthFailed(ctx.authFailedSentinelPath))) {
      trial = 0;
      lastError = null;
      await sleep(idleMs, signal);
      continue;
    }

    if (trial >= maxRetries) {
      await recordAuthRecoveryState(ctx.authFailedSentinelPath, {
        attempts: trial,
        maxRetries,
        exhausted: true,
        lastError,
      });
      await sleep(idleMs, signal);
      continue;
    }

    trial += 1;
    await recordAuthRecoveryState(ctx.authFailedSentinelPath, {
      attempts: trial,
      maxRetries,
      exhausted: false,
      lastError,
    });

    await sleep(baseDelayMs * 2 ** (trial - 1), signal);
    if (aborted(signal)) return;
    if (!(await isAuthFailed(ctx.authFailedSentinelPath))) {
      trial = 0;
      lastError = null;
      continue;
    }

    try {
      const result = await ctx.verifyKey();
      if (result.success) {
        await clearAuthFailedSentinel(ctx.authFailedSentinelPath);
        ctx.logger?.info(
          { event: 'auth.recovered', attempts: trial },
          'gateway key re-verified; resuming capture and uploads',
        );
        trial = 0;
        lastError = null;
        continue;
      }
      lastError = 'gateway key rejected by server';
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    const exhausted = trial >= maxRetries;
    await recordAuthRecoveryState(ctx.authFailedSentinelPath, {
      attempts: trial,
      maxRetries,
      exhausted,
      lastError,
    });
    ctx.logger?.warn(
      { event: 'auth.recovery_attempt_failed', attempts: trial, max: maxRetries, error: lastError },
      exhausted
        ? 'auth recovery exhausted; will not retry until reconfigured'
        : 'auth recovery attempt failed; will retry with backoff',
    );
  }
}
