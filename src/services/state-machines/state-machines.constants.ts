import type { MachineName } from 'services/state-machines/state-machines.types.ts';

export const ALL_MACHINES: readonly MachineName[] = [
  'daemon-root',
  'sentinel-registry',
  'capture-loop',
  'drain-loop',
  'heartbeat-loop',
  'binary-freshness',
  'auto-upgrade',
  'source-poll',
  'cursor-lifecycle',
  'batch-lifecycle',
  'quarantine-lifecycle',
  'pacer',
  'worker',
  'service-manager',
  'setup',
  'uninstall',
];

export const SENTINEL_WATCHER_DEBOUNCE_MS = 50;

export const SNAPSHOT_FLUSH_INTERVAL_MS = 1_000;
