import type { DestinationStream, Logger as PinoLogger } from 'pino';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

export type Logger = PinoLogger;

export interface LoggerFactoryOptions {
  level?: LogLevel;
  filePath?: string;
  pretty?: boolean;
  bindings?: Record<string, unknown> | null;
  destination?: DestinationStream;
}
