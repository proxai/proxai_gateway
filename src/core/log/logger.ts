import { join } from 'node:path';

import pino from 'pino';
import pretty from 'pino-pretty';

import { logDir } from 'core/io/fs';
import { DEFAULT_LOG_LEVEL, STRUCTURED_LOG_FILENAME } from 'core/log/log.constants.ts';
import type { Logger, LoggerFactoryOptions } from 'core/log/log.types.ts';

export function createLogger(options: LoggerFactoryOptions = {}): Logger {
  const level = options.level ?? DEFAULT_LOG_LEVEL;
  const base = options.bindings ?? null;

  if (options.destination !== undefined) {
    return pino({ level, base }, options.destination);
  }

  if (options.filePath !== undefined) {
    const dest = pino.destination({ dest: options.filePath, mkdir: true, sync: false });
    return pino({ level, base }, dest);
  }

  if (options.pretty === true) {
    const dest = pretty({
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname',
    });
    return pino({ level, base }, dest);
  }

  return pino({ level, base }, pino.destination(1));
}

export function defaultLogFilePath(): string {
  return join(logDir(), STRUCTURED_LOG_FILENAME);
}
