import type { MinimalLogger } from 'core/log';
import type { SentinelRegistryEvent } from 'services/state-machines/sentinel-registry/sentinel-registry.types.ts';

export type SentinelKind = 'auth-failed' | 'buffer-full' | 'session-stopped' | 'update-available';

export interface SentinelWatcherPaths {
  readonly configDir: string;
  readonly authFailed: string;
  readonly bufferFull: string;
  readonly sessionStopped: string;
  readonly updateAvailable: string;
}

export interface SentinelEventTarget {
  send(event: SentinelRegistryEvent): void;
}

export interface SentinelWatcherDeps {
  readonly paths: SentinelWatcherPaths;
  readonly target: SentinelEventTarget;
  readonly logger?: MinimalLogger;
  readonly debounceMs?: number;
}

export interface SentinelWatcherHandle {
  stop(): Promise<void>;
}
