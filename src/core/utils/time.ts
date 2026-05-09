export function nowIsoUtc(): string {
  return new Date().toISOString();
}

export function daysSince(iso: string, now: Date): number | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const diff = Math.floor((now.getTime() - ms) / 86_400_000);
  return diff < 0 ? 0 : diff;
}

export function monotonicMs(): number {
  return performance.now();
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.resolve();
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
