import type { DaemonStateSnapshot } from 'services/buffer';

import type { StatusHealth } from 'cli/commands/status/decorators.ts';

export interface DeriveHealthInputs {
  authFailed: boolean;
  bufferFull: boolean;
  sessionStopped: boolean;
  hasRecentActivity: boolean;
  drain: DaemonStateSnapshot | null;
}

export function deriveHealth(deps: DeriveHealthInputs): StatusHealth {
  if (deps.authFailed || deps.bufferFull || deps.sessionStopped) return 'error';
  if (!deps.hasRecentActivity) return 'inactive';
  if (
    deps.drain !== null &&
    deps.drain.lastDrainRetriable !== null &&
    deps.drain.lastDrainRetriable > 0
  ) {
    return 'warning';
  }
  return 'healthy';
}
