import type { Database } from 'bun:sqlite';
import chalk from 'chalk';

import { EXIT_CODE } from 'cli/cli.constants.ts';
import type { CommandResult, OutputSink } from 'cli/cli.types.ts';
import {
  countByStatus,
  countsBySource,
  getDaemonState,
  getLastPruneAt,
  totalFailedBytes,
  totalPendingBytes,
} from 'services/buffer';
import type { CountsBySource, DaemonStateSnapshot, SourceCycleResult } from 'services/buffer';
import {
  isAuthFailed,
  isBufferFull,
  isPaused,
  readAuthFailedSentinel,
  readBufferFullSentinel,
  readPauseReason,
  readSessionStoppedSentinel,
  readUpdateAvailableSentinel,
} from 'services/polling';
import {
  deriveHealth,
  formatBytes,
  formatLocalTimestamp,
  formatRelative,
  formatTimeWithRelative,
  sectionHeader,
  statusDot,
} from 'cli/commands/format-status.ts';

export { formatBytes };

const SOURCE_ORDER: ('claude-code' | 'cursor' | 'codex')[] = ['claude-code', 'cursor', 'codex'];
const SOURCE_LABEL_WIDTH = 12;

export interface StatusCommandDeps {
  output: OutputSink;
  buffer?: Database;
  configPath: string;
  configExists: () => Promise<boolean>;
  pauseSentinelPath: string;
  bufferFullSentinelPath: string;
  authFailedSentinelPath: string;
  sessionStoppedSentinelPath: string;
  updateAvailableSentinelPath?: string;
  now?: () => Date;
}

export interface StatusCommandOptions {
  json?: boolean;
}

export interface StatusJsonOutput {
  configured: boolean;
  health: string;
  sentinels: {
    paused: boolean;
    pausedReason: string | null;
    authFailed: boolean;
    authFailedReason: string | null;
    bufferFull: boolean;
    bufferFullPendingBytes: number | null;
    sessionStopped: boolean;
    updateAvailable: { latestVersion: string; currentVersion: string } | null;
  };
  capture: Record<string, SourceCycleResult> | null;
  buffer: {
    pending: number;
    pendingBytes: number;
    failed: number;
    failedBytes: number;
    delivered: number;
    bufferFull: boolean;
    lastPruneAt: string | null;
    sourceCounts: CountsBySource | null;
  };
  upload: {
    lastCycleStartedAt: string | null;
    lastCycleCompletedAt: string | null;
    lastCycleDurationMs: number | null;
    attempted: number | null;
    accepted: number | null;
    retriable: number | null;
    fatal: number | null;
    recovered: number | null;
    lastUploadError: string | null;
    consecutiveRetriableBreak: boolean | null;
  };
}

export async function runStatus(
  deps: StatusCommandDeps,
  options: StatusCommandOptions = {},
): Promise<CommandResult> {
  const exists = await deps.configExists();
  if (!exists) {
    if (options.json === true) {
      const empty: StatusJsonOutput = {
        configured: false,
        health: 'inactive',
        sentinels: {
          paused: false,
          pausedReason: null,
          authFailed: false,
          authFailedReason: null,
          bufferFull: false,
          bufferFullPendingBytes: null,
          sessionStopped: false,
          updateAvailable: null,
        },
        capture: null,
        buffer: {
          pending: 0,
          pendingBytes: 0,
          failed: 0,
          failedBytes: 0,
          delivered: 0,
          bufferFull: false,
          lastPruneAt: null,
          sourceCounts: null,
        },
        upload: {
          lastCycleStartedAt: null,
          lastCycleCompletedAt: null,
          lastCycleDurationMs: null,
          attempted: null,
          accepted: null,
          retriable: null,
          fatal: null,
          recovered: null,
          lastUploadError: null,
          consecutiveRetriableBreak: null,
        },
      };
      deps.output.info(JSON.stringify(empty));
      return { exitCode: EXIT_CODE.notInstalled };
    }
    deps.output.info(`Status: ${statusDot('inactive')} not configured`);
    deps.output.info('');
    deps.output.info(`Run ${chalk.cyan('proxai-gateway setup')} to begin.`);
    deps.output.info(
      `If you have not installed it yet, see ${chalk.cyan('https://proxai.co')} for install instructions.`,
    );
    return { exitCode: EXIT_CODE.notInstalled };
  }

  if (deps.buffer === undefined) {
    deps.output.error('buffer database is unavailable');
    return { exitCode: EXIT_CODE.error };
  }

  const buffer = deps.buffer;
  const counts = countByStatus(buffer);
  const pendingBytes = totalPendingBytes(buffer);
  const failedBytes = totalFailedBytes(buffer);
  const sourceCounts = countsBySource(buffer);
  const lastPruneAt = getLastPruneAt(buffer);
  const daemonState = getDaemonState(buffer);

  const paused = await isPaused(deps.pauseSentinelPath);
  const pausedReason = paused ? (await readPauseReason(deps.pauseSentinelPath)).trim() : '';
  const authFailed = await isAuthFailed(deps.authFailedSentinelPath);
  const authFailedPayload = authFailed
    ? await readAuthFailedSentinel(deps.authFailedSentinelPath)
    : null;
  const bufferFullFlag = await isBufferFull(deps.bufferFullSentinelPath);
  const bufferFullPayload = bufferFullFlag
    ? await readBufferFullSentinel(deps.bufferFullSentinelPath)
    : null;
  const sessionStoppedPayload = await readSessionStoppedSentinel(deps.sessionStoppedSentinelPath);
  const sessionStopped = sessionStoppedPayload !== null;
  const updateAvailable =
    deps.updateAvailableSentinelPath !== undefined
      ? await readUpdateAvailableSentinel(deps.updateAvailableSentinelPath)
      : null;

  const hasRecentActivity = daemonState !== null && daemonState.lastCycleCompletedAt !== null;
  const health = deriveHealth({
    paused,
    authFailed,
    bufferFull: bufferFullFlag,
    sessionStopped,
    hasRecentActivity,
    drain: daemonState,
  });

  if (options.json === true) {
    const json: StatusJsonOutput = {
      configured: true,
      health,
      sentinels: {
        paused,
        pausedReason: pausedReason.length > 0 ? pausedReason : null,
        authFailed,
        authFailedReason: authFailedPayload?.reason ?? null,
        bufferFull: bufferFullFlag,
        bufferFullPendingBytes: bufferFullPayload?.pendingBytes ?? null,
        sessionStopped,
        updateAvailable:
          updateAvailable === null
            ? null
            : {
                latestVersion: updateAvailable.latestVersion,
                currentVersion: updateAvailable.currentVersion,
              },
      },
      capture: daemonState?.lastSourceCaptures ?? null,
      buffer: {
        pending: counts.pending,
        pendingBytes,
        failed: counts.failed,
        failedBytes,
        delivered: counts.delivered,
        bufferFull: bufferFullFlag,
        lastPruneAt,
        sourceCounts,
      },
      upload: {
        lastCycleStartedAt: daemonState?.lastCycleStartedAt ?? null,
        lastCycleCompletedAt: daemonState?.lastCycleCompletedAt ?? null,
        lastCycleDurationMs: daemonState?.lastCycleDurationMs ?? null,
        attempted: daemonState?.lastDrainAttempted ?? null,
        accepted: daemonState?.lastDrainAccepted ?? null,
        retriable: daemonState?.lastDrainRetriable ?? null,
        fatal: daemonState?.lastDrainFatal ?? null,
        recovered: daemonState?.lastDrainRecovered ?? null,
        lastUploadError: daemonState?.lastUploadError ?? null,
        consecutiveRetriableBreak: daemonState?.lastConsecutiveRetriableBreak ?? null,
      },
    };
    deps.output.info(JSON.stringify(json));
    return { exitCode: EXIT_CODE.ok };
  }

  renderHumanStatus(deps, {
    health,
    paused,
    pausedReason,
    authFailed,
    authFailedReason: authFailedPayload?.reason ?? '',
    authFailedDetectedAt: authFailedPayload?.detectedAt ?? '',
    bufferFull: bufferFullFlag,
    bufferFullPendingBytes: bufferFullPayload?.pendingBytes ?? null,
    bufferFullThreshold: bufferFullPayload?.threshold ?? null,
    sessionStopped,
    sessionStoppedSetAt: sessionStoppedPayload?.setAt ?? null,
    updateAvailable,
    hasRecentActivity,
    counts,
    pendingBytes,
    failedBytes,
    sourceCounts,
    lastPruneAt,
    daemonState,
    now: deps.now ?? ((): Date => new Date()),
  });

  return { exitCode: EXIT_CODE.ok };
}

interface RenderInput {
  health: ReturnType<typeof deriveHealth>;
  paused: boolean;
  pausedReason: string;
  authFailed: boolean;
  authFailedReason: string;
  authFailedDetectedAt: string;
  bufferFull: boolean;
  bufferFullPendingBytes: number | null;
  bufferFullThreshold: number | null;
  sessionStopped: boolean;
  sessionStoppedSetAt: string | null;
  updateAvailable: Awaited<ReturnType<typeof readUpdateAvailableSentinel>>;
  hasRecentActivity: boolean;
  counts: { pending: number; failed: number; delivered: number };
  pendingBytes: number;
  failedBytes: number;
  sourceCounts: CountsBySource;
  lastPruneAt: string | null;
  daemonState: DaemonStateSnapshot | null;
  now: () => Date;
}

function renderHumanStatus(deps: StatusCommandDeps, input: RenderInput): void {
  const out = deps.output;
  const dot = statusDot(input.health);
  const label = renderHealthLabel(input);
  out.info(`Status: ${dot} ${label}`);

  renderSentinelLines(out, input);

  const lastCompletedAt = input.daemonState?.lastCycleCompletedAt ?? null;

  out.info('');
  out.info(sectionHeader('Capture'));
  for (const app of SOURCE_ORDER) {
    out.info(renderSourceRow(app, input.daemonState?.lastSourceCaptures[app]));
  }

  out.info('');
  out.info(sectionHeader('Buffer'));
  out.info(
    `  Pending      ${input.counts.pending.toString().padStart(4)} batches  (${formatBytes(input.pendingBytes)})`,
  );
  out.info(
    `  Failed       ${input.counts.failed.toString().padStart(4)} batches  (${formatBytes(input.failedBytes)})`,
  );
  out.info(`  Receipts     ${input.counts.delivered.toString().padStart(4)}`);
  out.info(`  Buffer full   ${input.bufferFull ? chalk.yellow('yes') : 'no'}`);
  if (input.lastPruneAt !== null) {
    out.info(`  Last prune    ${formatTimeWithRelative(input.lastPruneAt, { now: input.now() })}`);
  } else {
    out.info(`  Last prune    ${chalk.dim('never')}`);
  }

  out.info('');
  out.info(sectionHeader('Upload'));
  if (input.daemonState !== null && lastCompletedAt !== null) {
    const opts = { now: input.now() };
    out.info(`  Last cycle    ${formatTimeWithRelative(lastCompletedAt, opts)}`);
    out.info(
      `  Attempted     ${(input.daemonState.lastDrainAttempted ?? 0).toString()} batch${(input.daemonState.lastDrainAttempted ?? 0) === 1 ? '' : 'es'}     Accepted: ${(input.daemonState.lastDrainAccepted ?? 0).toString()}     ${
        (input.daemonState.lastDrainRetriable ?? 0) > 0
          ? chalk.yellow(`Retriable: ${(input.daemonState.lastDrainRetriable ?? 0).toString()}`)
          : `Retriable: ${(input.daemonState.lastDrainRetriable ?? 0).toString()}`
      }     ${
        (input.daemonState.lastDrainFatal ?? 0) > 0
          ? chalk.red(`Fatal: ${(input.daemonState.lastDrainFatal ?? 0).toString()}`)
          : `Fatal: ${(input.daemonState.lastDrainFatal ?? 0).toString()}`
      }`,
    );
    if (input.daemonState.lastUploadError !== null) {
      out.info(`  Last error    ${chalk.red(input.daemonState.lastUploadError)}`);
    }
    if (input.daemonState.lastConsecutiveRetriableBreak === true) {
      out.info(
        `  ${chalk.yellow('Drain backed off after consecutive retriable failures; will retry next cycle')}`,
      );
    }
  } else {
    out.info(
      `  ${chalk.dim('No upload cycle has completed yet (the daemon may still be running its first cycle).')}`,
    );
  }

  if (input.updateAvailable !== null) {
    out.info('');
    out.info(
      `${chalk.cyan('↑')} Update available: ${chalk.bold(input.updateAvailable.latestVersion)} (currently ${input.updateAvailable.currentVersion}) — run ${chalk.cyan('proxai-gateway upgrade')}`,
    );
  }
}

function renderHealthLabel(input: RenderInput): string {
  if (input.authFailed) return chalk.red('auth failed');
  if (input.paused) return chalk.red('paused');
  if (input.bufferFull) return chalk.red('buffer full');
  if (input.sessionStopped) return chalk.red('stopped (session)');
  if (!input.hasRecentActivity) return chalk.dim('starting');
  if (
    input.daemonState !== null &&
    input.daemonState.lastDrainRetriable !== null &&
    input.daemonState.lastDrainRetriable > 0
  ) {
    return chalk.yellow('active (degraded)');
  }
  return chalk.green('active');
}

function renderSentinelLines(out: OutputSink, input: RenderInput): void {
  if (input.authFailed) {
    const reason = input.authFailedReason.length > 0 ? input.authFailedReason : 'unknown';
    let when = '';
    if (input.authFailedDetectedAt.length > 0) {
      when = ` (since ${formatLocalTimestamp(input.authFailedDetectedAt)})`;
    }
    out.info(
      `  ${chalk.red('AUTH_FAILED')}: ${reason}${when} — re-run ${chalk.cyan('proxai-gateway setup')}`,
    );
  }
  if (input.paused) {
    const reason = input.pausedReason.length > 0 ? `: ${input.pausedReason}` : '';
    out.info(
      `  ${chalk.red('PAUSED')}${reason} — run ${chalk.cyan('proxai-gateway resume')} to continue`,
    );
  }
  if (input.bufferFull) {
    const detail =
      input.bufferFullPendingBytes !== null
        ? ` (pending ${formatBytes(input.bufferFullPendingBytes)})`
        : '';
    out.info(
      `  ${chalk.red('BUFFER_FULL')}${detail} — captures paused until pending bytes drop below the resume threshold`,
    );
  }
  if (input.sessionStopped) {
    let when = '';
    if (input.sessionStoppedSetAt !== null && input.sessionStoppedSetAt.length > 0) {
      when = ` (set ${formatRelative(input.sessionStoppedSetAt)})`;
    }
    out.info(
      `  ${chalk.red('SESSION_STOPPED')}${when} — restart with ${chalk.cyan('proxai-gateway start')}`,
    );
  }
}

function renderSourceRow(app: string, capture: SourceCycleResult | undefined): string {
  const padded = app.padEnd(SOURCE_LABEL_WIDTH);
  if (capture === undefined) {
    return `  ${padded}${chalk.dim('  0 captured  /   0 files scanned  /  0 errors')}`;
  }
  const captured = capture.capturedBatches.toString().padStart(3);
  const files = capture.filesProcessed.toString().padStart(3);
  const errors = capture.errorsCount;
  const errorsStr =
    errors === 0
      ? `${errors.toString()} errors`
      : chalk.yellow(`${errors.toString()} errors${errors > 0 ? ' (locked)' : ''}`);
  return `  ${padded}${captured} captured  /  ${files} files scanned  /  ${errorsStr}`;
}
