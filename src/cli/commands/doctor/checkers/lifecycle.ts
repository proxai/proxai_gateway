import { Confidence, Severity } from 'cli/commands/doctor/doctor.types.ts';
import type { DoctorSignals, Finding } from 'cli/commands/doctor/doctor.types.ts';
import { MAX_CONSECUTIVE_FAILURES } from 'services/rescue/rescue-decision.ts';

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
  if (signals.rescue.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return null;
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
  if (signals.sentinels.authFailed) return null;
  const lastResumedAt = signals.daemonState.lastResumedAt;
  if (lastResumedAt !== null) {
    const resumedMs = Date.parse(lastResumedAt);
    if (Number.isFinite(resumedMs) && Date.now() - resumedMs < 300_000) {
      return null;
    }
  }
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
    cause: `The gateway background daemon is active but has stalled; no sessions have been captured in the last ${minutesAgo} minutes. If this condition persists, the auto-recovery watchdog will restart the daemon automatically.`,
    action:
      'No action is required if the auto-recovery watchdog is running. Alternatively, you can restart the daemon immediately to clear the stall: "proxai-gateway restart"',
  };
}

export function checkA16RescueCircuitBreakerTripped(signals: DoctorSignals): Finding | null {
  if (signals.rescue.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES && !signals.daemonRunning) {
    return {
      code: 'A16',
      severity: Severity.critical,
      confidence: Confidence.confirmed,
      cause: `The rescue circuit breaker was tripped because the daemon failed to start ${MAX_CONSECUTIVE_FAILURES.toString()} or more times consecutively.`,
      action:
        'Inspect the daemon logs to find why it keeps failing to start, then run "proxai-gateway logs" and "proxai-gateway restart". Once the daemon stays up, auto-recovery resumes automatically.',
    };
  }
  return null;
}

export function checkA17WatchdogMissing(signals: DoctorSignals): Finding | null {
  if (!signals.configExists) return null;
  if (!signals.serviceUnitRegistered) return null;
  if (signals.watchdog.installed) return null;
  return {
    code: 'A17',
    severity: Severity.warning,
    confidence: Confidence.confirmed,
    cause:
      'The auto-recovery watchdog is not installed, so if the daemon stops it will not be automatically restarted.',
    action: 'Run "proxai-gateway start" to reinstall the watchdog.',
  };
}
