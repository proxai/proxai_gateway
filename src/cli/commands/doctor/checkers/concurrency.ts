import { Confidence, Severity } from 'cli/commands/doctor/doctor.types.ts';
import type { DoctorSignals, Finding } from 'cli/commands/doctor/doctor.types.ts';

export function checkG4JournalMode(signals: DoctorSignals): Finding | null {
  if (!signals.bufferDbReadable) {
    return null;
  }
  const mode = signals.sqliteExtended.dbJournalMode;
  if (mode === null || mode.toLowerCase() === 'wal') {
    return null;
  }
  return {
    code: 'G4',
    severity: Severity.warning,
    confidence: Confidence.confirmed,
    cause: `The database journal mode is set to '${mode}' instead of WAL, degrading concurrency.`,
    action: `Restart the daemon to re-initialize WAL mode, or delete ${signals.configDirPath}/buffer.db for a clean re-creation.`,
  };
}

export function checkG5BusyTimeout(signals: DoctorSignals): Finding | null {
  if (!signals.bufferDbReadable) {
    return null;
  }
  const timeout = signals.sqliteExtended.dbBusyTimeoutMs;
  if (timeout !== null && timeout >= 2000) {
    return null;
  }
  return {
    code: 'G5',
    severity: Severity.critical,
    confidence: Confidence.confirmed,
    cause: `The database busy timeout of ${timeout ?? 0}ms is below the 2000ms threshold, causing direct write failures on lock contention.`,
    action: 'Configure PRAGMA busy_timeout = 5000 in your connection instantiation.',
  };
}

export function checkG6TransactionLockup(signals: DoctorSignals): Finding | null {
  if (!signals.bufferDbReadable || !signals.daemonRunning) {
    return null;
  }
  if (!signals.sqliteExtended.dbTransactionLockup) {
    return null;
  }
  return {
    code: 'G6',
    severity: Severity.critical,
    confidence: Confidence.likely,
    cause:
      'A long-running or leaked database transaction has locked database writes, wedging the queue.',
    action:
      'Restart the background daemon to release the database write lock: "proxai-gateway restart".',
  };
}

export function checkG7WalCheckpointStarvation(signals: DoctorSignals): Finding | null {
  if (!signals.bufferDbReadable) {
    return null;
  }
  const isStarved = signals.sqliteExtended.dbWalCheckpointBusy === true;
  if (!isStarved) {
    return null;
  }
  return {
    code: 'G7',
    severity: Severity.warning,
    confidence: Confidence.confirmed,
    cause:
      'An active connection is holding an unclosed transaction, preventing WAL checkpoints from truncating the journal.',
    action:
      'Restart the background daemon to force-close active connections and release lingering read locks.',
  };
}

export function checkG8UncommittedJournalStaleLock(signals: DoctorSignals): Finding | null {
  if (signals.daemonRunning) {
    return null;
  }
  const isBlocked = signals.processExtended.zombieProcessesDetected;
  if (!isBlocked) {
    return null;
  }
  return {
    code: 'G8',
    severity: Severity.critical,
    confidence: Confidence.confirmed,
    cause:
      'A zombie background process is holding a lock on the WAL journal, blocking new service instances.',
    action: 'Run "ps aux | grep proxai-gateway" to locate orphaned processes and terminate them.',
  };
}
