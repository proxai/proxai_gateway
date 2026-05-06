import { join } from 'node:path';

import pino from 'pino';
import pinoRoll from 'pino-roll';
import pretty from 'pino-pretty';

import { logDir as defaultLogDir } from 'core/io/fs';
import {
  DEFAULT_LOG_LEVEL,
  LOG_RETENTION_DAYS,
  STRUCTURED_LOG_BASENAME,
  STRUCTURED_LOG_DATE_FORMAT,
  STRUCTURED_LOG_EXTENSION,
  STRUCTURED_LOG_FILENAME,
} from 'core/log/log.constants.ts';
import type { Logger, LoggerFactoryOptions } from 'core/log/log.types.ts';

export async function createLogger(options: LoggerFactoryOptions = {}): Promise<Logger> {
  const level = options.level ?? DEFAULT_LOG_LEVEL;
  const base = options.bindings ?? null;

  if (options.destination !== undefined) {
    return pino({ level, base }, options.destination);
  }

  if (options.logDir !== undefined) {
    const stream = await pinoRoll({
      file: join(options.logDir, STRUCTURED_LOG_BASENAME),
      frequency: 'daily',
      dateFormat: STRUCTURED_LOG_DATE_FORMAT,
      extension: STRUCTURED_LOG_EXTENSION,
      mkdir: true,
      sync: true,
      limit: { count: LOG_RETENTION_DAYS },
    });
    return pino({ level, base }, stream);
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
  return join(defaultLogDir(), STRUCTURED_LOG_FILENAME);
}
