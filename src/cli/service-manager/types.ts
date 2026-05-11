export interface ServiceRuntimeInfo {
  pid: number | null;
  startedAt: Date | null;
}

export interface ServiceManager {
  ensureRegistered(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  unregister(): Promise<void>;
  isRegistered(): Promise<boolean>;
  isRunning(): Promise<boolean>;
  runtimeInfo(): Promise<ServiceRuntimeInfo>;
}

export interface CommandRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type SpawnFn = (
  argv: string[],
  options: { stdout: 'pipe'; stderr: 'pipe' },
) => {
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exitCode: number | null;
};

export interface ServiceManagerDeps {
  platform: NodeJS.Platform;
  unitPath: string;
  spawn?: SpawnFn;
}
