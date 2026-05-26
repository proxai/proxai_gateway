import type { Logger } from 'pino';

export type MachineName =
  | 'daemon-root'
  | 'sentinel-registry'
  | 'capture-loop'
  | 'drain-loop'
  | 'heartbeat-loop'
  | 'binary-freshness'
  | 'auto-upgrade'
  | 'source-poll'
  | 'cursor-lifecycle'
  | 'batch-lifecycle'
  | 'quarantine-lifecycle'
  | 'pacer'
  | 'worker'
  | 'service-manager'
  | 'setup'
  | 'uninstall';

export interface MachineRuntime {
  readonly name: MachineName;
  readonly logger: Logger;
}

export interface SentinelPaths {
  readonly authFailed: string;
  readonly paused: string;
  readonly bufferFull: string;
  readonly sessionStopped: string;
  readonly consentAccepted: string;
  readonly updateAvailable: string;
}

export type SentinelKind = keyof SentinelPaths;
