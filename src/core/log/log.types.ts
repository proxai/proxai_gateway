import type { DestinationStream, Logger as PinoLogger } from 'pino';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

export type Logger = PinoLogger;

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
