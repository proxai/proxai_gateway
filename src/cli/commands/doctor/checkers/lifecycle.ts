import { Confidence, Severity } from 'cli/commands/doctor/doctor.types.ts';
import type { DoctorSignals, Finding } from 'cli/commands/doctor/doctor.types.ts';

const STALE_CYCLE_MULTIPLIER = 2;
const CAPTURE_INTERVAL_MS = 120_000;

export function checkA1NotSetUp(signals: DoctorSignals): Finding | null {
  if (signals.configExists) return null;
  return {
    code: 'A1',
    severity: Severity.critical,
    confidence: Confidence.confirmed,
    cause: 'Gateway not set up — config.toml absent',
    action: 'Run: proxai-gateway setup',
  };
}

export function checkA2UnitNotRegistered(signals: DoctorSignals): Finding | null {
  if (!signals.configExists) return null;
  if (signals.serviceUnitRegistered) return null;
  return {
    code: 'A2',
    severity: Severity.critical,
    confidence: Confidence.confirmed,
    cause: 'Config present but service unit not registered',
    action: 'Run: proxai-gateway start  (or setup --force to re-register)',
  };
}

export function checkA3StoppedByUser(signals: DoctorSignals): Finding | null {
  if (!signals.configExists) return null;
  if (!signals.serviceUnitRegistered) return null;
  if (signals.daemonRunning) return null;
  if (!signals.sentinels.sessionStopped) return null;
  return {
    code: 'A3',
    severity: Severity.warning,
    confidence: Confidence.confirmed,
    cause: 'Daemon stopped by user (SESSION_STOPPED sentinel present)',
    action: 'Run: proxai-gateway start',
  };
}

export function checkA4Crashed(signals: DoctorSignals): Finding | null {
  if (!signals.configExists) return null;
  if (!signals.serviceUnitRegistered) return null;
  if (signals.daemonRunning) return null;
  if (signals.sentinels.sessionStopped) return null;
  return {
    code: 'A4',
    severity: Severity.critical,
    confidence: Confidence.likely,
    cause: 'Daemon not running, no SESSION_STOPPED sentinel — likely crashed or failed to spawn',
    action: 'Run: proxai-gateway restart; send logs if problem persists',
  };
}

export function checkA5Wedged(signals: DoctorSignals): Finding | null {
  if (!signals.daemonRunning) return null;
  const lastCycleAt = signals.daemonState.captureLastCycleAt;
  if (lastCycleAt === null) return null;
  const ms = Date.parse(lastCycleAt);
  if (!Number.isFinite(ms)) return null;
  const stallThreshold = CAPTURE_INTERVAL_MS * STALE_CYCLE_MULTIPLIER;
  if (Date.now() - ms < stallThreshold) return null;
  return {
    code: 'A5',
    severity: Severity.warning,
    confidence: Confidence.likely,
    cause: `Daemon running but last capture cycle was ${Math.round((Date.now() - ms) / 60_000)} min ago (stale)`,
    action: 'Run: proxai-gateway restart; capture logs if problem persists',
  };
}
