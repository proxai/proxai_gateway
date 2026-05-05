import type { Database } from 'bun:sqlite';

import { EXIT_CODE } from 'cli/cli.constants.ts';
import type { CommandResult, OutputSink } from 'cli/cli.types.ts';
import { countByStatus, totalPendingBytes } from 'services/buffer';
import { isPaused } from 'services/polling';

export interface StatusCommandDeps {
  output: OutputSink;
  buffer: Database;
  sentinelPath: string;
}

export async function runStatus(deps: StatusCommandDeps): Promise<CommandResult> {
  const counts = countByStatus(deps.buffer);
  const pendingBytes = totalPendingBytes(deps.buffer);
  const paused = await isPaused(deps.sentinelPath);

  deps.output.info(`status: ${paused ? 'PAUSED' : 'active'}`);
  deps.output.info(
    `pending: ${counts.pending.toString()} batch(es), ${pendingBytes.toString()} bytes`,
  );
  deps.output.info(`done: ${counts.done.toString()}`);
  deps.output.info(`failed: ${counts.failed.toString()}`);

  return { exitCode: EXIT_CODE.ok };
}
