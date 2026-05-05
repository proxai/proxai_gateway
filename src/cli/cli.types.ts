export interface OutputSink {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  success(msg: string): void;
}

export interface CommandResult {
  exitCode: number;
}
