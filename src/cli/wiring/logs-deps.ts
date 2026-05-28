import { join } from 'node:path';

import type { LogsCommandDeps } from 'cli/commands/logs';
import { openBufferDb } from 'services/buffer';
import { readDevModeSentinel } from 'core/io/fs';
import { buildProfileContext, profileRootDir } from 'core/io/fs/profile.ts';
import { consoleOutput } from 'cli/output.ts';
import type { Database } from 'bun:sqlite';

export interface BuildLogsDepsInputs {
  readonly bufferPath?: string;
}

export interface LogsDepsContext {
  readonly deps: LogsCommandDeps;
  readonly cleanup: () => void;
}

export async function buildLogsDeps(inputs: BuildLogsDepsInputs = {}): Promise<LogsDepsContext> {
  const path = inputs.bufferPath ?? buildProfileContext('prod').bufferDbPath;
  let buffer: Database | null = null;

  try {
    buffer = openBufferDb(path);
  } catch {
    buffer = null;
  }

  const isDevMode = await readDevModeSentinel(join(profileRootDir(), 'DEV_MODE'));

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
