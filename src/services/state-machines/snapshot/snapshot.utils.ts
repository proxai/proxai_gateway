import type {
  MachineSnapshot,
  SnapshotRegistry,
} from 'services/state-machines/snapshot/snapshot.types.ts';

export function parseSnapshotRegistry(json: string | null): SnapshotRegistry {
  if (json === null || json.length === 0) return {};
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as SnapshotRegistry;
  } catch {
    return {};
  }
}

export function serializeSnapshotRegistry(registry: SnapshotRegistry): string {
  return JSON.stringify(registry);
}

export function buildSnapshot(
  value: unknown,
  context: unknown,
  status: MachineSnapshot['status'],
  capturedAtUtc: string,
): MachineSnapshot {
  return { value, context, status, capturedAtUtc };
}
