import type { Database } from 'bun:sqlite';
import { getMachineSnapshots, setMachineSnapshots } from 'services/buffer';
import type { SnapshotRegistry } from 'services/state-machines/snapshot/snapshot.types.ts';
import {
  parseSnapshotRegistry,
  serializeSnapshotRegistry,
} from 'services/state-machines/snapshot/snapshot.utils.ts';

export function persistSnapshotRegistry(db: Database, registry: SnapshotRegistry): void {
  setMachineSnapshots(db, serializeSnapshotRegistry(registry));
}

export function loadSnapshotRegistry(db: Database): SnapshotRegistry {
  return parseSnapshotRegistry(getMachineSnapshots(db));
}
