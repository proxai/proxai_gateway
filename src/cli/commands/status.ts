import type { Database } from 'bun:sqlite';

import { EXIT_CODE } from 'cli/cli.constants.ts';
import type { CommandResult, OutputSink } from 'cli/cli.types.ts';
import {
  countByStatus,
  getLastPruneAt,
  totalFailedBytes,
  totalPendingBytes,
} from 'services/buffer';
import { isBufferFull, isPaused, readUpdateAvailableSentinel } from 'services/polling';

export interface StatusCommandDeps {
  output: OutputSink;
  buffer: Database;
  sentinelPath: string;
  bufferFullSentinelPath: string;
  updateAvailableSentinelPath?: string;
}

export async function runStatus(deps: StatusCommandDeps): Promise<CommandResult> {
  const counts = countByStatus(deps.buffer);
  const pendingBytes = totalPendingBytes(deps.buffer);
  const failedBytes = totalFailedBytes(deps.buffer);
  const paused = await isPaused(deps.sentinelPath);
  const bufferFull = await isBufferFull(deps.bufferFullSentinelPath);
  const lastPruneAt = getLastPruneAt(deps.buffer);

  deps.output.info(`status: ${paused ? 'PAUSED' : 'active'}`);
  deps.output.info(
    `pending: ${counts.pending.toString()} batch(es), ${pendingBytes.toString()} bytes`,
  );
  deps.output.info(`pending_bytes: ${formatBytes(pendingBytes)}`);
  deps.output.info(`failed_bytes: ${formatBytes(failedBytes)}`);
  deps.output.info(`receipt_count: ${counts.delivered.toString()}`);
  deps.output.info(`buffer_full: ${bufferFull ? 'yes' : 'no'}`);
  deps.output.info(`last_prune_at: ${lastPruneAt ?? 'never'}`);
  deps.output.info(`delivered: ${counts.delivered.toString()}`);
  deps.output.info(`failed: ${counts.failed.toString()}`);

  if (deps.updateAvailableSentinelPath !== undefined) {
    const update = await readUpdateAvailableSentinel(deps.updateAvailableSentinelPath);
    if (update !== null) {
      deps.output.info(
        `update_available: ${update.latestVersion} (currently ${update.currentVersion}) — run \`proxai-gateway upgrade\``,
      );
    }
  }

  return { exitCode: EXIT_CODE.ok };
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${n.toString()} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let unitIdx = 0;
  while (value >= 1024 && unitIdx < units.length - 1) {
    value /= 1024;
    unitIdx++;
  }
  const rounded = value < 10 ? value.toFixed(2) : value < 100 ? value.toFixed(1) : value.toFixed(0);
  return `${rounded} ${units[unitIdx] ?? 'B'}`;
}
