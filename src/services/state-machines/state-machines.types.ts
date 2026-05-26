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
