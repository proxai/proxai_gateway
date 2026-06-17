import { sentinelHandle } from 'core/io/fs';

export interface RescueLedger {
  bootId: string;
  lastRescueAt: string | null;
  consecutiveFailures: number;
  attempts: Array<{ at: string; action: 'start' | 'restart' }>;
  lastObservedHeartbeatAt: string | null;
}

export async function readRescueLedger(
  path: string,
  currentBootId: string,
): Promise<RescueLedger | null> {
  const text = await sentinelHandle(path).read();
  if (text.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const bootId = typeof parsed['bootId'] === 'string' ? parsed['bootId'] : '';
    const lastRescueAt = typeof parsed['lastRescueAt'] === 'string' ? parsed['lastRescueAt'] : null;
    const consecutiveFailures =
      typeof parsed['consecutiveFailures'] === 'number' ? parsed['consecutiveFailures'] : 0;
    const attempts = Array.isArray(parsed['attempts']) ? parsed['attempts'] : [];
    const lastObservedHeartbeatAt =
      typeof parsed['lastObservedHeartbeatAt'] === 'string'
        ? parsed['lastObservedHeartbeatAt']
        : null;

    const ledger: RescueLedger = {
      bootId,
      lastRescueAt,
      consecutiveFailures,
      attempts: attempts as Array<{ at: string; action: 'start' | 'restart' }>,
      lastObservedHeartbeatAt,
    };

    if (bootId !== currentBootId) {
      ledger.bootId = currentBootId;
      ledger.consecutiveFailures = 0;
      ledger.attempts = [];
      ledger.lastRescueAt = null;
      ledger.lastObservedHeartbeatAt = null;
      await writeRescueLedger(path, ledger);
    }
    return ledger;
  } catch {
    return null;
  }
}

export async function readRescueLedgerReadOnly(
  path: string,
  currentBootId: string,
): Promise<RescueLedger | null> {
  const text = await sentinelHandle(path).read();
  if (text.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const bootId = typeof parsed['bootId'] === 'string' ? parsed['bootId'] : '';
    if (bootId !== currentBootId) {
      return {
        bootId: currentBootId,
        lastRescueAt: null,
        consecutiveFailures: 0,
        attempts: [],
        lastObservedHeartbeatAt: null,
      };
    }
    const lastRescueAt = typeof parsed['lastRescueAt'] === 'string' ? parsed['lastRescueAt'] : null;
    const consecutiveFailures =
      typeof parsed['consecutiveFailures'] === 'number' ? parsed['consecutiveFailures'] : 0;
    const attempts = Array.isArray(parsed['attempts']) ? parsed['attempts'] : [];
    const lastObservedHeartbeatAt =
      typeof parsed['lastObservedHeartbeatAt'] === 'string'
        ? parsed['lastObservedHeartbeatAt']
        : null;

    return {
      bootId,
      lastRescueAt,
      consecutiveFailures,
      attempts: attempts as Array<{ at: string; action: 'start' | 'restart' }>,
      lastObservedHeartbeatAt,
    };
  } catch {
    return null;
  }
}

export async function writeRescueLedger(path: string, ledger: RescueLedger): Promise<void> {
  await sentinelHandle(path).write(JSON.stringify(ledger));
}

export async function clearRescueLedger(path: string): Promise<void> {
  await sentinelHandle(path).remove();
}

export function recordRescueAttempt(
  ledger: RescueLedger,
  at: string,
  action: 'start' | 'restart',
): void {
  ledger.lastRescueAt = at;
  ledger.attempts.push({ at, action });
  if (ledger.attempts.length > 20) {
    ledger.attempts = ledger.attempts.slice(ledger.attempts.length - 20);
  }
}

export function markDaemonHealthy(ledger: RescueLedger): void {
  ledger.consecutiveFailures = 0;
}

export function markRescueFailed(ledger: RescueLedger): void {
  ledger.consecutiveFailures += 1;
}
