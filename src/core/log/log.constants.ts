import type { LogLevel } from 'core/log/log.types.ts';

export const DEFAULT_LOG_LEVEL: LogLevel = 'trace';

export const STRUCTURED_LOG_FILENAME = 'structured.log';
export const STRUCTURED_LOG_BASENAME = 'structured';
export const STRUCTURED_LOG_EXTENSION = '.log';
export const STRUCTURED_LOG_DATE_FORMAT = 'yyyy-MM-dd';

export const LOG_RETENTION_DAYS = 90;
export const LOG_TOTAL_SIZE_CAP_BYTES = 5 * 1024 ** 3;

export const VALID_LOG_LEVELS: readonly LogLevel[] = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
];
