const DAEMON_INFER_FROM_DRAIN_MS = 90_000;
const DAEMON_INFER_FROM_CAPTURE_MS = 360_000;

export function inferDaemonAlive(
  drainLastCycleAt: string | null,
  captureLastCycleAt: string | null,
  now: Date,
): boolean {
  const nowMs = now.getTime();
  if (drainLastCycleAt !== null) {
    const t = Date.parse(drainLastCycleAt);
    if (Number.isFinite(t) && nowMs - t < DAEMON_INFER_FROM_DRAIN_MS) return true;
  }
  if (captureLastCycleAt !== null) {
    const t = Date.parse(captureLastCycleAt);
    if (Number.isFinite(t) && nowMs - t < DAEMON_INFER_FROM_CAPTURE_MS) return true;
  }
  return false;
}
