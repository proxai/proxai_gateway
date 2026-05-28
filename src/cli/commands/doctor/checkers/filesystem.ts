import { Confidence, Severity } from 'cli/commands/doctor/doctor.types.ts';
import type { DoctorSignals, Finding } from 'cli/commands/doctor/doctor.types.ts';

const LOW_DISK_THRESHOLD = 500 * 1024 * 1024;
const CLOCK_SKEW_WARN_MS = 5 * 60 * 1000;

export function checkF1ConfigDirNotWritable(signals: DoctorSignals): Finding | null {
  if (signals.filesystem.configDirWritable) return null;
  return {
    code: 'F1',
    severity: Severity.critical,
    confidence: Confidence.confirmed,
    cause: 'configDir is not writable (EACCES) — daemon cannot write sentinels or buffer',
    action: 'Fix permissions: chmod u+w <configDir>',
  };
}

export function checkF2DiskSpaceLow(signals: DoctorSignals): Finding | null {
  if (signals.filesystem.diskFreeBytes === null) return null;
  if (signals.filesystem.diskFreeBytes >= LOW_DISK_THRESHOLD) return null;
  const mb = Math.round(signals.filesystem.diskFreeBytes / (1024 * 1024));
  return {
    code: 'F2',
    severity: Severity.critical,
    confidence: Confidence.confirmed,
    cause: `Disk space critically low: ${mb.toString()} MiB free`,
    action: 'Free disk space; the buffer cannot grow and upgrades will fail',
  };
}

export function checkF3LogDirNotWritable(signals: DoctorSignals): Finding | null {
  if (signals.filesystem.logDirWritable) return null;
  return {
    code: 'F3',
    severity: Severity.warning,
    confidence: Confidence.confirmed,
    cause: 'logDir is not writable — structured logging is degraded',
    action: 'Fix permissions on the gateway log directory',
  };
}

export function checkF4ClockSkew(signals: DoctorSignals): Finding | null {
  if (signals.clockSkewMs === null) return null;
  if (Math.abs(signals.clockSkewMs) < CLOCK_SKEW_WARN_MS) return null;
  const skewMin = Math.round(Math.abs(signals.clockSkewMs) / 60_000);
  return {
    code: 'F4',
    severity: Severity.warning,
    confidence: Confidence.likely,
    cause: `System clock may be skewed by ~${skewMin.toString()} min — watermark/timestamp anomalies possible`,
    action: 'Check NTP sync; ensure system clock is accurate',
  };
}

export function checkF5LinuxNoLinger(signals: DoctorSignals): Finding | null {
  if (signals.platform !== 'linux') return null;
  if (signals.systemdLingerEnabled === null) return null;
  if (signals.systemdLingerEnabled) return null;
  return {
    code: 'F5',
    severity: Severity.warning,
    confidence: Confidence.confirmed,
    cause: 'Systemd linger is disabled — daemon stops when you log out',
    action: 'Run: loginctl enable-linger $USER',
  };
}

export function checkF6WindowsUserUnresolvable(signals: DoctorSignals): Finding | null {
  if (signals.platform !== 'win32') return null;
  if (signals.systemdLingerEnabled !== null) return null;
  return null;
}

export function checkF7MacOsQuarantine(signals: DoctorSignals): Finding | null {
  if (signals.platform !== 'darwin') return null;
  if (signals.macOsQuarantineXattr === null) return null;
  if (!signals.macOsQuarantineXattr) return null;
  return {
    code: 'F7',
    severity: Severity.critical,
    confidence: Confidence.confirmed,
    cause: 'com.apple.quarantine xattr present on binary — macOS Gatekeeper may block execution',
    action: 'Run: xattr -d com.apple.quarantine <binary-path>',
  };
}
