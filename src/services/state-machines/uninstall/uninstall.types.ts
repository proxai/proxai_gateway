export type UninstallPhase =
  | 'idle'
  | 'stopping_service'
  | 'sweeping_paths'
  | 'removing_buffer'
  | 'removing_sentinels'
  | 'done'
  | 'failed';

export interface UninstallInput {
  readonly resetMode: boolean;
}

export interface UninstallContext {
  readonly resetMode: boolean;
  serviceStopped: boolean;
  pathsSwept: number;
  bufferRemoved: boolean;
  sentinelsRemoved: number;
  lastError: string | null;
}

export type UninstallEvent =
  | { type: 'BEGIN' }
  | { type: 'SERVICE_STOPPED' }
  | { type: 'PATHS_SWEPT'; count: number }
  | { type: 'BUFFER_REMOVED' }
  | { type: 'SENTINELS_REMOVED'; count: number }
  | { type: 'ERROR'; message: string };
