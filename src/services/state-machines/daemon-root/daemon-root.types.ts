export type DaemonRootPhase =
  | 'boot'
  | 'syncing_watermarks'
  | 'running'
  | 'draining_for_shutdown'
  | 'exited';

export interface DaemonRootContext {
  bootedAtUtc: string | null;
  exitedAtUtc: string | null;
  watermarksSynced: boolean;
  shutdownReason: 'sigterm' | 'sigint' | 'upgrade' | 'fatal' | null;
}

export type DaemonRootEvent =
  | { type: 'BOOT_LOADING_CONFIG' }
  | { type: 'CONFIG_LOADED' }
  | { type: 'BUFFER_OPENED' }
  | { type: 'WATERMARKS_SYNCED' }
  | { type: 'WATERMARKS_SKIPPED' }
  | { type: 'READY'; bootedAtUtc: string }
  | { type: 'SHUTDOWN'; reason: 'sigterm' | 'sigint' | 'upgrade' | 'fatal' }
  | { type: 'DRAIN_FOR_SHUTDOWN_COMPLETE' }
  | { type: 'EXIT'; exitedAtUtc: string };
