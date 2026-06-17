import { Confidence, Severity } from 'cli/commands/doctor/doctor.types.ts';
import type { DoctorSignals, Finding } from 'cli/commands/doctor/doctor.types.ts';

export function checkA13SystemdRuntimeDirMissing(signals: DoctorSignals): Finding | null {
  if (signals.systemdExtended.systemdRuntimeDirMissing !== true) {
    return null;
  }
  return {
    code: 'A13',
    severity: Severity.critical,
    confidence: Confidence.confirmed,
    cause:
      'The XDG_RUNTIME_DIR variable is missing in this non-interactive shell, blocking user-level systemctl connection.',
    action:
      'Export the user runtime directory: export XDG_RUNTIME_DIR="/run/user/$(id -u)" inside your shell profiles.',
  };
}

export function checkA14SystemdRateLimitHit(signals: DoctorSignals): Finding | null {
  if (signals.systemdExtended.systemdRateLimitHit !== true) {
    return null;
  }
  return {
    code: 'A14',
    severity: Severity.critical,
    confidence: Confidence.confirmed,
    cause:
      'The service manager has rate-limited this daemon (start-limit-hit) due to repeated startup failures.',
    action:
      'Reset the failure count and retry: "systemctl --user reset-failed proxai-gateway.service". Note that the watchdog will attempt paced recovery (reset-failed + start, capped at once per hour), and if it ultimately gives up, finding A16 will be shown.',
  };
}

export function checkA15SystemdHomeEncryptedTearing(signals: DoctorSignals): Finding | null {
  if (signals.systemdExtended.systemdHomeEncryptedTearing !== true) {
    return null;
  }
  return {
    code: 'A15',
    severity: Severity.critical,
    confidence: Confidence.likely,
    cause:
      'The user home directory is encrypted and gets unmounted on logout, tearing down active daemon files under linger.',
    action:
      'Relocate the buffer database file path in config.toml to an unencrypted, persistent volume like /var/lib.',
  };
}
