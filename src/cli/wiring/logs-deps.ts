import { existsSync } from 'node:fs';

import type { LogsCommandDeps } from 'cli/commands/logs';
import { openBufferDb } from 'services/buffer';
import { bufferDbPath, devModeSentinelPath } from 'core/io/fs';
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

  const isDevMode = existsSync(devModeSentinelPath());

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
