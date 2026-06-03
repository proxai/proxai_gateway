import { chmodSync } from 'node:fs';
import { join } from 'node:path';

import pino from 'pino';
import pinoRoll from 'pino-roll';
import pretty from 'pino-pretty';

import { buildProfileContext } from 'core/io/fs/profile.ts';
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

    secureLogStream(stream);
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
  return join(buildProfileContext('prod').logDir, STRUCTURED_LOG_FILENAME);
}

interface FileLikeStream {
  file?: unknown;
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
}

export function secureLogStream(stream: unknown): void {
  const s = stream as FileLikeStream;
  if (typeof s.on === 'function') {
    s.on('error', (err: unknown) => {
      process.stderr.write(
        `[Logger Stream Error] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
      );
    });
  }

  if (process.platform === 'win32') return;
  applySecureMode(s);
  if (typeof s.on === 'function') {
    s.on('ready', () => {
      applySecureMode(s);
    });
  }
}

function applySecureMode(stream: FileLikeStream): void {
  const filePath = typeof stream.file === 'string' ? stream.file : null;
  if (filePath === null || filePath.length === 0) return;
  try {
    chmodSync(filePath, 0o600);
  } catch {}
}
