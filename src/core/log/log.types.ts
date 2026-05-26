import type { DestinationStream, Logger as PinoLogger } from 'pino';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

export type Logger = PinoLogger;

export interface MinimalLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  fatal(...args: unknown[]): void;
  trace(...args: unknown[]): void;
  child(bindings: Record<string, unknown>): MinimalLogger;
}

export interface LoggerFactoryOptions {
  level?: LogLevel;
  pretty?: boolean;
  bindings?: Record<string, unknown> | null;
  destination?: DestinationStream;
  logDir?: string;
}

export interface PruneLogDirectoryOptions {
  retentionDays?: number;
  totalSizeCapBytes?: number;
  setMode?: (path: string, mode: number) => Promise<void>;
}

export interface PruneResult {
  deletedFiles: string[];
  retainedBytes: number;
  retainedCount: number;
}
