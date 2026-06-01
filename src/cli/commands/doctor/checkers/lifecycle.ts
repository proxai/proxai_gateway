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
    cause: "The gateway is not configured because the required 'config.toml' file is missing.",
    action: "Run 'proxai-gateway setup' to configure the gateway and generate the missing file.",
  };
}

export function checkA2UnitNotRegistered(signals: DoctorSignals): Finding | null {
  if (!signals.configExists) return null;
  if (signals.serviceUnitRegistered) return null;
  if (signals.sentinels.sessionStopped) return null;
  return {
    code: 'A2',
    severity: Severity.critical,
    confidence: Confidence.confirmed,
    cause:
      'The gateway is configured, but its background daemon is not registered as a system service.',
    action:
      "Run 'proxai-gateway start' to register and start the daemon, or run 'proxai-gateway setup new' to reconfigure.",
  };
}

export function checkA3StoppedByUser(signals: DoctorSignals): Finding | null {
  if (!signals.configExists) return null;
  if (signals.daemonRunning) return null;
  if (!signals.sentinels.sessionStopped) return null;
  return {
    code: 'A3',
    severity: Severity.warning,
    confidence: Confidence.confirmed,
    cause:
      'The gateway background daemon was manually stopped. Session capture and telemetry are currently inactive.',
    action: 'Start the background daemon to resume session capturing: "proxai-gateway start"',
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
    cause:
      'The gateway background daemon is inactive (likely due to a startup failure or unexpected crash).',
    action:
      'Restart the service by running "proxai-gateway restart". If the issue persists, run "proxai-gateway logs" to inspect the failure logs.',
  };
}

export function checkA5Wedged(signals: DoctorSignals): Finding | null {
  if (!signals.daemonRunning) return null;
  // Capture is intentionally paused while AUTH_FAILED is set (auth recovery in
  // progress), so a stale capture cycle is expected, not a wedge — B1 already
  // covers the real problem.
  if (signals.sentinels.authFailed) return null;
  const lastCycleAt = signals.daemonState.captureLastCycleAt;
  if (lastCycleAt === null) return null;
  const ms = Date.parse(lastCycleAt);
  if (!Number.isFinite(ms)) return null;
  const stallThreshold = CAPTURE_INTERVAL_MS * STALE_CYCLE_MULTIPLIER;
  if (Date.now() - ms < stallThreshold) return null;
  const minutesAgo = Math.round((Date.now() - ms) / 60_000);
  return {
    code: 'A5',
    severity: Severity.warning,
    confidence: Confidence.likely,
    cause: `The gateway background daemon is active but has stalled; no sessions have been captured in the last ${minutesAgo} minutes.`,
    action:
      'Restart the background daemon to clear the stall and resume capture: "proxai-gateway restart"',
  };
}
