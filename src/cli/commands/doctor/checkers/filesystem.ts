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
    cause: `The gateway configuration directory (${signals.configDirPath}) is not writable due to restricted file permissions.`,
    action: `Grant read and write permissions by running "chmod -R u+rw ${signals.configDirPath}" (macOS/Linux) or adjusting folder security access settings (Windows).`,
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
    cause: `The primary storage partition is critically low on space, with only ${mb.toString()} MiB free.`,
    action:
      'Free up at least 500 MiB of disk space on the primary partition to allow the gateway local database and log writer to operate safely.',
  };
}

export function checkF3LogDirNotWritable(signals: DoctorSignals): Finding | null {
  if (signals.filesystem.logDirWritable) return null;
  return {
    code: 'F3',
    severity: Severity.warning,
    confidence: Confidence.confirmed,
    cause: `The gateway log directory (${signals.logDirPath}) is not writable due to restricted file permissions.`,
    action: `Grant write permissions to the log directory by running "chmod -R u+rw ${signals.logDirPath}" (macOS/Linux) or adjusting folder security access settings (Windows).`,
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
    cause: `The system clock is inaccurate by approximately ${skewMin.toString()} minutes, which can cause API request signature and authentication failures.`,
    action:
      'Enable automatic date and time synchronization (NTP) in your operating system settings to align the system clock.',
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
    cause:
      'Systemd user linger is disabled, which terminates the background gateway service when your SSH or terminal session logs out.',
    action:
      'Enable user lingering by running "loginctl enable-linger $USER" to keep the background daemon running continuously after logout.',
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
    cause:
      'macOS has placed a quarantine flag on the gateway binary, preventing Gatekeeper from executing unsigned code.',
    action:
      'Clear the macOS quarantine flag by running: "xattr -d com.apple.quarantine $(which proxai-gateway)"',
  };
}
