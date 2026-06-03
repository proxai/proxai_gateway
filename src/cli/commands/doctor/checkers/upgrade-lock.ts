import { Confidence, Severity } from 'cli/commands/doctor/doctor.types.ts';
import type { DoctorSignals, Finding } from 'cli/commands/doctor/doctor.types.ts';

export function checkE5UpgradeLockStale(signals: DoctorSignals): Finding | null {
  if (!signals.upgradeExtended.upgradeLockExists) {
    return null;
  }
  if (!signals.upgradeExtended.upgradeLockStale) {
    return null;
  }
  return {
    code: 'E5',
    severity: Severity.warning,
    confidence: Confidence.confirmed,
    cause:
      'A stale upgrade lock (.upgrade.lock) file exists from a failed upgrade run, blocking future updates.',
    action: `Delete the stale lock file manually: "rm ${signals.configDirPath}/.upgrade.lock" and restart the daemon.`,
  };
}

export function checkE6CorruptedUpgradeBinary(signals: DoctorSignals): Finding | null {
  if (!signals.upgradeExtended.upgradeStagedBinaryCorrupt) {
    return null;
  }
  return {
    code: 'E6',
    severity: Severity.critical,
    confidence: Confidence.confirmed,
    cause:
      'The staged auto-upgrade binary is corrupted, empty, or truncated, causing coordinated startup crashes.',
    action:
      'Delete staged binary files manually and execute a clean upgrade cycle: "proxai-gateway upgrade --force".',
  };
}
