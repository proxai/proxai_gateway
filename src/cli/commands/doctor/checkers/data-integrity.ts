import { Confidence, Severity } from 'cli/commands/doctor/doctor.types.ts';
import type { DoctorSignals, Finding } from 'cli/commands/doctor/doctor.types.ts';

const REGRESSION_LOOP_THRESHOLD = 3;

export function checkG1ReceiptsTableReadable(signals: DoctorSignals): Finding | null {
  if (!signals.configExists) return null;
  if (signals.receiptsTableReadable) return null;

  return {
    code: 'G1',
    severity: Severity.critical,
    confidence: Confidence.confirmed,
    cause:
      'The local buffer database receipts table is unreadable or missing, indicating database schema corruption.',
    action:
      'Restart the gateway daemon to let it auto-recreate the tables, or delete ~/.proxai/buffer.db to force a clean sync.',
  };
}

export function checkG2BufferDbCorrupt(signals: DoctorSignals): Finding | null {
  if (!signals.configExists) return null;
  if (signals.bufferDbReadable) return null;

  return {
    code: 'G2',
    severity: Severity.critical,
    confidence: Confidence.confirmed,
    cause: 'The local buffer SQLite database file is corrupted or unreadable.',
    action:
      'Delete the corrupted ~/.proxai/buffer.db file and restart the gateway daemon to reinitialize a healthy database.',
  };
}

export function checkG3RegressionLoop(signals: DoctorSignals): Finding | null {
  const loops = signals.resyncEvents.regressionLoops.filter(
    (l) => l.countInLastHour > REGRESSION_LOOP_THRESHOLD,
  );
  if (loops.length === 0) return null;

  const hashes = loops.map((l) => l.sourcePathHash.slice(0, 8)).join(', ');
  const maxCount = Math.max(...loops.map((l) => l.countInLastHour));

  return {
    code: 'G3',
    severity: Severity.warning,
    confidence: Confidence.likely,
    cause: `Watermark regression loop detected for ${loops.length.toString()} source(s) [${hashes}] with up to ${maxCount.toString()} regressions in the last hour.`,
    action:
      'Restart the gateway daemon to flush the event state. If the loop persists, check for a duplicate host using the same profile or a restored stale database backup.',
  };
}
