import { Confidence, Severity } from 'cli/commands/doctor/doctor.types.ts';
import type { DoctorSignals, Finding } from 'cli/commands/doctor/doctor.types.ts';

export function checkC1RateLimited(signals: DoctorSignals): Finding | null {
  if (signals.recentEvents.rateLimitedCount <= 0) return null;
  return {
    code: 'C1',
    severity: Severity.warning,
    confidence: Confidence.confirmed,
    cause: `Server is rate-limiting this host (${signals.recentEvents.rateLimitedCount} rate-limit events)`,
    action: 'Contact ops with your host_id to investigate',
  };
}

export function checkC2NetworkFailure(signals: DoctorSignals): Finding | null {
  if (signals.network.nestReachable === true) return null;
  if (signals.network.nestReachable === null) return null;
  if (signals.sentinels.authFailed) return null;
  if (signals.recentEvents.rateLimitedCount > 0) return null;
  return {
    code: 'C2',
    severity: Severity.critical,
    confidence: Confidence.confirmed,
    cause: 'Nest endpoint unreachable — network / DNS / TCP / SSL inspection blocking uploads',
    action: 'Check network connectivity and proxy settings to the nest endpoint',
  };
}

export function checkC3DrainWedged(signals: DoctorSignals): Finding | null {
  if (!signals.daemonRunning) return null;
  if (signals.buffer.pendingCount === 0) return null;
  if (signals.sentinels.authFailed) return null;
  if (signals.sentinels.bufferFull) return null;
  if (signals.network.nestReachable === false) return null;

  const drainAt = signals.daemonState.drainLastCycleAt;
  if (drainAt === null) return null;
  const ms = Date.parse(drainAt);
  if (!Number.isFinite(ms)) return null;
  const DRAIN_INTERVAL_MS = 30_000;
  const STALL_THRESHOLD = DRAIN_INTERVAL_MS * 4;
  if (Date.now() - ms < STALL_THRESHOLD) return null;

  return {
    code: 'C3',
    severity: Severity.warning,
    confidence: Confidence.likely,
    cause: `Pending batches exist but drain cycle last ran ${Math.round((Date.now() - ms) / 60_000)} min ago with no gating sentinel`,
    action: 'Run: proxai-gateway restart',
  };
}

export function checkC4BufferRecovery(signals: DoctorSignals): Finding | null {
  if (!signals.sentinels.bufferFull) return null;
  const drainAt = signals.daemonState.drainLastCycleAt;
  if (drainAt === null) return null;
  const ms = Date.parse(drainAt);
  if (!Number.isFinite(ms)) return null;
  const DRAIN_INTERVAL_MS = 30_000;
  if (Date.now() - ms > DRAIN_INTERVAL_MS * 3) return null;

  return {
    code: 'C4',
    severity: Severity.info,
    confidence: Confidence.confirmed,
    cause: 'BUFFER_FULL sentinel active but drain is advancing — buffer recovery in progress',
    action: 'No action needed; this is working as designed and will self-clear',
  };
}

export function checkC5BufferOscillating(signals: DoctorSignals): Finding | null {
  if (signals.buffer.pendingBytes === 0) return null;
  if (!signals.sentinels.bufferFull) return null;
  const drainAt = signals.daemonState.drainLastCycleAt;
  if (drainAt === null) return null;
  const ms = Date.parse(drainAt);
  if (!Number.isFinite(ms)) return null;
  const DRAIN_INTERVAL_MS = 30_000;
  if (Date.now() - ms > DRAIN_INTERVAL_MS * 3) return null;
  if (signals.buffer.pendingCount < 2) return null;

  return {
    code: 'C5',
    severity: Severity.warning,
    confidence: Confidence.confirmed,
    cause: 'Buffer pressure oscillating — drain is slower than capture rate',
    action: 'Consider raising upload_max_bytes_per_minute in config.toml',
  };
}

export function checkC6ParserValidationErrors(signals: DoctorSignals): Finding | null {
  if (signals.recentEvents.fatalValidationErrorCount <= 0) return null;
  return {
    code: 'C6',
    severity: Severity.critical,
    confidence: Confidence.confirmed,
    cause: `Parser emitting invalid records — ${signals.recentEvents.fatalValidationErrorCount} fatal ValidationError events`,
    action: 'Send this doctor output to the team; run inspect to examine the failing batches',
  };
}

export function checkC7QuarantinedRows(signals: DoctorSignals): Finding | null {
  if (signals.buffer.quarantinedCount === 0) return null;
  return {
    code: 'C7',
    severity: Severity.info,
    confidence: Confidence.confirmed,
    cause: `${signals.buffer.quarantinedCount} oversized row(s) quarantined (>10 MiB decompressed)`,
    action: 'No action needed; oversized rows are skipped by design',
  };
}
