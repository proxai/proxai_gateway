import type { Database } from 'bun:sqlite';
import type { MinimalLogger } from 'core/log';
import type { Actor } from 'xstate';
import type { DaemonRootMachine } from 'services/state-machines/daemon-root';
import type { SentinelRegistryMachine } from 'services/state-machines/sentinel-registry';
import type { SentinelWatcherPaths } from 'services/state-machines/sentinel-watcher';

export interface DaemonActorsInput {
  readonly buffer: Database;
  readonly paths: SentinelWatcherPaths;
  readonly logger?: MinimalLogger;
  readonly snapshotIntervalMs?: number;
  readonly xstateInspect?: boolean | undefined;
}

export interface DaemonActorsHandle {
  readonly registry: Actor<SentinelRegistryMachine>;
  readonly root: Actor<DaemonRootMachine>;
  readonly markReady: (bootedAtUtc: string) => void;
  readonly requestShutdown: (reason: 'sigterm' | 'sigint' | 'upgrade' | 'fatal') => void;
  readonly markExited: (exitedAtUtc: string) => void;
  readonly flushSnapshots: () => void;
  readonly stop: () => Promise<void>;
}
