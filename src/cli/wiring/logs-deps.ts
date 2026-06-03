import type { Database } from 'bun:sqlite';

import type { LogsCommandDeps } from 'cli/commands/logs';
import { openReadOnlyBufferDb } from 'services/buffer';
import type { ProfileContext } from 'core/io/fs/profile.types.ts';
import { resolveProfilePaths } from 'cli/wiring/resolve-profile-paths.ts';
import { consoleOutput } from 'cli/output.ts';

export interface BuildLogsDepsInputs {
  readonly profileCtx: ProfileContext;
}

export interface LogsDepsContext {
  readonly deps: LogsCommandDeps;
  readonly cleanup: () => void;
}

export async function buildLogsDeps(inputs: BuildLogsDepsInputs): Promise<LogsDepsContext> {
  const { bufferDbPath } = await resolveProfilePaths(inputs.profileCtx);
  let buffer: Database | null = null;
  try {
    buffer = openReadOnlyBufferDb(bufferDbPath);
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
