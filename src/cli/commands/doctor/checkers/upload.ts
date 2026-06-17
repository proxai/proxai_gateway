import { Confidence, Severity } from 'cli/commands/doctor/doctor.types.ts';
import type { DoctorSignals, Finding } from 'cli/commands/doctor/doctor.types.ts';

export function checkC1RateLimited(signals: DoctorSignals): Finding | null {
  if (signals.recentEvents.rateLimitedCount <= 0) return null;
  return {
    code: 'C1',
    severity: Severity.warning,
    confidence: Confidence.confirmed,
    cause: `The server is rate-limiting this host's upload requests (${signals.recentEvents.rateLimitedCount} rate-limit events detected).`,
    action:
      'Provide the host_id from your config.toml to the operations team to request a rate limit adjustment.',
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
    cause:
      'The Nest API endpoint is unreachable due to a network connection, DNS lookup, firewall, or SSL proxy inspection blockage.',
    action:
      'Verify your internet connection and ensure outbound traffic is allowed without SSL inspection or proxy interception to the Nest endpoint.',
  };
}

export function checkC3DrainWedged(signals: DoctorSignals): Finding | null {
  if (!signals.daemonRunning) return null;
  if (signals.buffer.pendingCount === 0) return null;
  if (signals.sentinels.authFailed) return null;
  if (signals.sentinels.bufferFull) return null;
  if (signals.network.nestReachable === false) return null;

  const lastResumedAt = signals.daemonState.lastResumedAt;
  if (lastResumedAt !== null) {
    const resumedMs = Date.parse(lastResumedAt);
    if (Number.isFinite(resumedMs) && Date.now() - resumedMs < 300_000) {
      return null;
    }
  }

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
    cause: `Pending database batches are queued for upload, but the background daemon has stalled and has not performed a drain cycle in ${Math.round((Date.now() - ms) / 60_000)} minutes.`,
    action:
      'Restart the background service daemon to force a fresh upload queue cycle by running: proxai-gateway restart',
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
    cause:
      'The upload buffer is full because telemetry capture exceeded the upload rate, but the daemon is actively draining pending batches',
    action:
      'No action required. Wait for the background daemon to finish uploading; the gateway will automatically resume accepting new records.',
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
    cause:
      'The upload buffer is under heavy pressure because the telemetry capture rate is faster than the background upload speed',
    action:
      'Increase upload_max_bytes_per_minute in config.toml, or check if network bandwidth is limited.',
  };
}

export function checkC6ParserValidationErrors(signals: DoctorSignals): Finding | null {
  if (signals.recentEvents.fatalValidationErrorCount <= 0) return null;
  return {
    code: 'C6',
    severity: Severity.critical,
    confidence: Confidence.confirmed,
    cause: `The gateway parser is producing malformed telemetry records that fail schema validation (${signals.recentEvents.fatalValidationErrorCount} fatal validation errors)`,
    action:
      "Run 'proxai-gateway inspect' to examine the failing batches, and report these validation errors to the development team.",
  };
}

export function checkC7QuarantinedRows(signals: DoctorSignals): Finding | null {
  if (signals.buffer.quarantinedCount === 0) return null;
  return {
    code: 'C7',
    severity: Severity.info,
    confidence: Confidence.confirmed,
    cause: `The upload buffer quarantined ${signals.buffer.quarantinedCount} oversized telemetry row(s) because they exceed the 10 MiB decompressed limit`,
    action:
      'No action required. The system skipped these rows to protect the gateway from memory exhaustion. Inspect client payloads to ensure they stay under 10 MiB.',
  };
}
