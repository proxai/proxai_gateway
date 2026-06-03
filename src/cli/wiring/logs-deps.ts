import type { LogsCommandDeps } from 'cli/commands/logs';
import { openReadOnlyBufferDb } from 'services/buffer';
import { buildProfileContext } from 'core/io/fs/profile.ts';
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
    buffer = openReadOnlyBufferDb(path);
  } catch {
    buffer = null;
  }

  const deps: LogsCommandDeps = {
    output: consoleOutput(),
    buffer,
  };

  return {
    deps,
    cleanup: () => {
      buffer?.close();
    },
  };
}
