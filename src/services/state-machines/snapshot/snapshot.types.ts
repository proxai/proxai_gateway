import type { MachineName } from 'services/state-machines/state-machines.types.ts';

export interface MachineSnapshot {
  readonly value: unknown;
  readonly context: unknown;
  readonly status: 'active' | 'done' | 'error' | 'stopped';
  readonly capturedAtUtc: string;
}

export type SnapshotRegistry = Partial<Record<MachineName, MachineSnapshot>>;
