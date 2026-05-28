import { Confidence, Severity } from 'cli/commands/doctor/doctor.types.ts';
import type { DoctorSignals, Finding } from 'cli/commands/doctor/doctor.types.ts';

const REGRESSION_LOOP_THRESHOLD = 3;

export function checkG1ReceiptsTableReadable(signals: DoctorSignals): Finding | null {
  if (signals.buffer.receiptCount > 0) return null;
  if (signals.buffer.pendingCount > 0 || signals.buffer.failedCount > 0) return null;
  return null;
}

export function checkG2BufferDbCorrupt(signals: DoctorSignals): Finding | null {
  if (signals.buffer.pendingCount > 0) return null;
  if (signals.buffer.receiptCount > 0) return null;
  if (!signals.configExists) return null;
  if (!signals.daemonRunning) return null;

  return null;
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
    cause: `Watermark regression loop detected for ${loops.length.toString()} source(s) [${hashes}] — ${maxCount.toString()} regressions in last hour`,
    action: 'Usually self-heals; if persistent, check for stale buffer backup or duplicate host',
  };
}
