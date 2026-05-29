import { Confidence, Severity } from 'cli/commands/doctor/doctor.types.ts';
import type { DoctorSignals, Finding } from 'cli/commands/doctor/doctor.types.ts';

const STALE_BINARY_DAYS = 60;
const MS_PER_DAY = 86_400_000;

export function checkE1StaleBinary(signals: DoctorSignals): Finding | null {
  if (signals.binary.mtime === null) return null;
  if (signals.binary.installSource === 'brew') return null;

  const ageMs = Date.now() - signals.binary.mtime.getTime();
  if (ageMs < STALE_BINARY_DAYS * MS_PER_DAY) return null;

  const hasUpgradeFailure = signals.recentEvents.autoUpgradeEvents.some(
    (e) =>
      e.includes('check_failed') ||
      e.includes('no_asset') ||
      e.includes('download_failed') ||
      e.includes('write_failed'),
  );

  if (!hasUpgradeFailure) return null;

  const firstEvent = signals.recentEvents.autoUpgradeEvents.find(
    (e) =>
      e.includes('check_failed') ||
      e.includes('no_asset') ||
      e.includes('download_failed') ||
      e.includes('write_failed'),
  );

  const errorDetail = firstEvent ?? 'unknown auto-upgrade failure';

  return {
    code: 'E1',
    severity: Severity.warning,
    confidence: Confidence.confirmed,
    cause: `The gateway binary is outdated (${Math.floor(ageMs / MS_PER_DAY)} days old) and background auto-upgrades are failing: ${errorDetail}.`,
    action: 'Run "proxai-gateway upgrade" to manually upgrade, or perform a manual reinstallation.',
  };
}

export function checkE2BrewUpdatePending(signals: DoctorSignals): Finding | null {
  if (!signals.sentinels.updateAvailable) return null;
  if (signals.binary.installSource !== 'brew') return null;
  return {
    code: 'E2',
    severity: Severity.info,
    confidence: Confidence.confirmed,
    cause: 'A newer version of proxai-gateway is available via Homebrew.',
    action: 'Run "brew upgrade proxai-gateway" to update to the latest version.',
  };
}

export function checkE3WriteFailed(signals: DoctorSignals): Finding | null {
  const writeFailed = signals.recentEvents.autoUpgradeEvents.some((e) =>
    e.includes('write_failed'),
  );
  if (!writeFailed) return null;

  if (
    signals.filesystem.diskFreeBytes !== null &&
    signals.filesystem.diskFreeBytes < 100 * 1024 * 1024
  ) {
    return {
      code: 'E3',
      severity: Severity.critical,
      confidence: Confidence.confirmed,
      cause: 'Auto-upgrade failed because the disk is nearly full.',
      action:
        'Free up disk space on the installation drive to allow the binary upgrade to complete.',
    };
  }

  if (!signals.filesystem.configDirWritable) {
    return {
      code: 'E3',
      severity: Severity.critical,
      confidence: Confidence.confirmed,
      cause: 'Auto-upgrade failed because the gateway configuration directory is not writable.',
      action:
        'Grant write permissions to the current user for the gateway configuration directory.',
    };
  }

  return {
    code: 'E3',
    severity: Severity.critical,
    confidence: Confidence.likely,
    cause: 'Auto-upgrade failed to write the updated binary due to a filesystem write error.',
    action: 'Manually upgrade the binary by running "proxai-gateway upgrade" or reinstalling.',
  };
}

export function checkE4SuccessOldVersionRunning(signals: DoctorSignals): Finding | null {
  const upgradeSucceeded = signals.recentEvents.autoUpgradeEvents.some((e) =>
    e.includes('success'),
  );
  if (!upgradeSucceeded) return null;
  if (signals.binary.mtime === null) return null;

  const ageMs = Date.now() - signals.binary.mtime.getTime();
  if (ageMs > 5 * 60 * 1000) {
    return {
      code: 'E4',
      severity: Severity.warning,
      confidence: Confidence.likely,
      cause: 'Auto-upgrade succeeded, but the active binary has not been updated.',
      action: 'Restart the gateway service by running: proxai-gateway restart',
    };
  }

  return null;
}
