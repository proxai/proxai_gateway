import type { LogLevel } from 'core/log/log.types.ts';

export const DEFAULT_LOG_LEVEL: LogLevel = 'info';

export const STRUCTURED_LOG_FILENAME = 'structured.log';

export const VALID_LOG_LEVELS: readonly LogLevel[] = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
];
