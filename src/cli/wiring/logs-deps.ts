import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { LogsCommandDeps } from 'cli/commands/logs';
import { openBufferDb } from 'services/buffer';
import { bufferDbPath } from 'core/io/fs';
import { profileRootDir } from 'core/io/fs/profile.ts';
import { consoleOutput } from 'cli/output.ts';
import type { Database } from 'bun:sqlite';

export interface BuildLogsDepsInputs {
  readonly bufferPath?: string;
}

export interface LogsDepsContext {
  readonly deps: LogsCommandDeps;
  readonly cleanup: () => void;
}

export function buildLogsDeps(inputs: BuildLogsDepsInputs = {}): LogsDepsContext {
  const path = inputs.bufferPath ?? bufferDbPath();
  let buffer: Database | null = null;

  try {
    buffer = openBufferDb(path);
  } catch {
    buffer = null;
  }

  const isDevMode = existsSync(join(profileRootDir(), 'DEV_MODE'));

  const deps: LogsCommandDeps = {
    output: consoleOutput(),
    buffer,
    isDevMode,
  };

  return {
    deps,
    cleanup: () => {
      buffer?.close();
    },
  };
}
