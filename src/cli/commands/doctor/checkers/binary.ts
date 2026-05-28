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

  const specificCause =
    firstEvent !== undefined ? `auto-upgrade failed: ${firstEvent}` : 'auto-upgrade failing';

  return {
    code: 'E1',
    severity: Severity.warning,
    confidence: Confidence.confirmed,
    cause: `Binary is ${Math.floor(ageMs / MS_PER_DAY)} days old and ${specificCause}`,
    action: 'Run: proxai-gateway upgrade  or reinstall manually',
  };
}

export function checkE2BrewUpdatePending(signals: DoctorSignals): Finding | null {
  if (!signals.sentinels.updateAvailable) return null;
  if (signals.binary.installSource !== 'brew') return null;
  return {
    code: 'E2',
    severity: Severity.info,
    confidence: Confidence.confirmed,
    cause: 'UPDATE_AVAILABLE sentinel present with install_source=brew',
    action: 'Run: brew upgrade proxai-gateway',
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
      cause: 'Auto-upgrade write_failed — disk is nearly full',
      action: 'Free disk space; the binary cannot be replaced until space is available',
    };
  }

  if (!signals.filesystem.configDirWritable) {
    return {
      code: 'E3',
      severity: Severity.critical,
      confidence: Confidence.confirmed,
      cause: 'Auto-upgrade write_failed — configDir not writable (permission mismatch)',
      action: 'Fix permissions on the gateway config directory',
    };
  }

  return {
    code: 'E3',
    severity: Severity.critical,
    confidence: Confidence.likely,
    cause:
      'Auto-upgrade write_failed — cause unclear (check disk space, binary path permissions, install/runtime uid)',
    action: 'Run: proxai-gateway upgrade  or reinstall manually',
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
      cause:
        'Auto-upgrade success logged but binary mtime is old — service manager may not have restarted cleanly',
      action: 'Run: proxai-gateway restart',
    };
  }

  return null;
}
