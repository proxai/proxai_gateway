import { Confidence, Severity } from 'cli/commands/doctor/doctor.types.ts';
import type { DoctorSignals, Finding } from 'cli/commands/doctor/doctor.types.ts';

export function checkG9InconsistentSessionUuids(signals: DoctorSignals): Finding | null {
  const isDrifted = signals.sqliteExtended.dbTransactionLockup;
  if (!isDrifted) {
    return null;
  }
  return {
    code: 'G9',
    severity: Severity.critical,
    confidence: Confidence.likely,
    cause:
      'IDE workspaces or session cache databases are cloned, leading to duplicate upstream session UUIDs.',
    action:
      'Clear your IDE cache directories or restart the session to re-seed secure random UUID properties.',
  };
}
