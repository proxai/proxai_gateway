import { DEFAULT_POLL_INTERVAL_MS } from 'services/polling/polling.constants.ts';
import { runPollCycle } from 'services/polling/poll-cycle.ts';
import type {
  PollCycleContext,
  PollCycleResult,
  PollLoopOptions,
} from 'services/polling/polling.types.ts';

export async function runPollLoop(
  ctx: PollCycleContext,
  options: PollLoopOptions = {},
): Promise<void> {
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const abortSignal = options.abortSignal;
  const onCycleComplete = options.onCycleComplete;

  while (abortSignal === undefined || !abortSignal.aborted) {
    const result = await runPollCycle(ctx);
    notifyCycleComplete(onCycleComplete, result);
    if (abortSignal !== undefined && abortSignal.aborted) return;
    await sleepUntilAbort(intervalMs, abortSignal);
  }
}

function notifyCycleComplete(
  callback: ((result: PollCycleResult) => void) | undefined,
  result: PollCycleResult,
): void {
  if (callback === undefined) return;
  try {
    callback(result);
  } catch {}
}

function sleepUntilAbort(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    function onAbort(): void {
      cleanup();
      resolve();
    }
    function cleanup(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
