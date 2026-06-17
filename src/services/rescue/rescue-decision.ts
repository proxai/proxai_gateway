import type { RescueLedger } from 'services/rescue/rescue-ledger.ts';

const SUSTAINED_DOWN_MS = 600_000;
const WEDGE_STALE_MS = 1_800_000;
const RESCUE_RATE_CAP_MS = 3_600_000;
export const MAX_CONSECUTIVE_FAILURES = 3;

export const RESUME_GAP_THRESHOLD_MS = 1_800_000;

export interface RescueDecisionInput {
  configExists: boolean;
  serviceUnitRegistered: boolean;
  isRunning: boolean;
  captureLastCycleAt: string | null;
  drainLastCycleAt: string | null;
  authFailedPresent: boolean;
  bufferFullPresent: boolean;
  sessionStoppedThisBoot: boolean;
  upgradeInProgress: boolean;
  ledger: RescueLedger | null;
  now: Date;
  likelyResumed: boolean;
}

export type RescueDecisionReason =
  | 'not-configured'
  | 'not-registered'
  | 'user-stopped'
  | 'paused'
  | 'upgrading'
  | 'healthy'
  | 'rate-capped'
  | 'circuit-broken';

export type RescueDecisionResult =
  | { kind: 'none'; reason: RescueDecisionReason }
  | { kind: 'start' }
  | { kind: 'restart' };

export function decideRescue(input: RescueDecisionInput): RescueDecisionResult {
  if (!input.configExists) {
    return { kind: 'none', reason: 'not-configured' };
  }
  if (!input.serviceUnitRegistered) {
    return { kind: 'none', reason: 'not-registered' };
  }
  if (input.sessionStoppedThisBoot) {
    return { kind: 'none', reason: 'user-stopped' };
  }
  if (input.upgradeInProgress) {
    return { kind: 'none', reason: 'upgrading' };
  }
  if (input.ledger !== null && input.ledger.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
    return { kind: 'none', reason: 'circuit-broken' };
  }
  if (input.ledger !== null && input.ledger.lastRescueAt !== null) {
    const lastRescueMs = Date.parse(input.ledger.lastRescueAt);
    if (Number.isFinite(lastRescueMs)) {
      const diff = input.now.getTime() - lastRescueMs;
      if (diff >= 0 && diff < RESCUE_RATE_CAP_MS) {
        return { kind: 'none', reason: 'rate-capped' };
      }
    }
  }

  let lastHeartbeatMs: number | null = null;
  if (input.captureLastCycleAt !== null) {
    const ms = Date.parse(input.captureLastCycleAt);
    if (Number.isFinite(ms)) {
      lastHeartbeatMs = ms;
    }
  }
  if (input.drainLastCycleAt !== null) {
    const ms = Date.parse(input.drainLastCycleAt);
    if (Number.isFinite(ms)) {
      if (lastHeartbeatMs === null || ms > lastHeartbeatMs) {
        lastHeartbeatMs = ms;
      }
    }
  }

  if (!input.isRunning) {
    if (lastHeartbeatMs === null) {
      return { kind: 'start' };
    }
    const age = input.now.getTime() - lastHeartbeatMs;
    if (age > SUSTAINED_DOWN_MS) {
      return { kind: 'start' };
    }
    return { kind: 'none', reason: 'healthy' };
  }

  if (input.authFailedPresent || input.bufferFullPresent) {
    return { kind: 'none', reason: 'paused' };
  }

  if (input.likelyResumed) {
    return { kind: 'none', reason: 'healthy' };
  }

  let captureWedged = false;
  if (
    input.captureLastCycleAt !== null &&
    input.ledger !== null &&
    input.ledger.lastObservedCaptureAt !== null
  ) {
    const capMs = Date.parse(input.captureLastCycleAt);
    const prevCapMs = Date.parse(input.ledger.lastObservedCaptureAt);
    if (Number.isFinite(capMs) && Number.isFinite(prevCapMs) && capMs === prevCapMs) {
      const age = input.now.getTime() - capMs;
      if (age > WEDGE_STALE_MS) {
        captureWedged = true;
      }
    }
  }

  let drainWedged = false;
  if (
    input.drainLastCycleAt !== null &&
    input.ledger !== null &&
    input.ledger.lastObservedDrainAt !== null
  ) {
    const drMs = Date.parse(input.drainLastCycleAt);
    const prevDrMs = Date.parse(input.ledger.lastObservedDrainAt);
    if (Number.isFinite(drMs) && Number.isFinite(prevDrMs) && drMs === prevDrMs) {
      const age = input.now.getTime() - drMs;
      if (age > WEDGE_STALE_MS) {
        drainWedged = true;
      }
    }
  }

  if (captureWedged || drainWedged) {
    return { kind: 'restart' };
  }

  return { kind: 'none', reason: 'healthy' };
}
