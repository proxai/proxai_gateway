import type { Database } from 'bun:sqlite';
import chalk from 'chalk';

import { EXIT_CODE } from 'cli/cli.constants.ts';
import type { CommandResult, OutputSink } from 'cli/cli.types.ts';
import type { ServiceManager } from 'cli/service-manager.ts';
import {
  countByStatus,
  countsBySource,
  getDaemonState,
  getLastPruneAt,
  getMetadata,
  METADATA_KEYS,
  totalFailedBytes,
  totalPendingBytes,
} from 'services/buffer';
import type { CountsBySource, DaemonStateSnapshot, SourceCycleResult } from 'services/buffer';
import type { GatewayConfig, InstallSource } from 'services/config';
import { loadConfigFromFile } from 'services/config';
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
  renderBufferSection,
  renderCaptureRow,
  renderHealthSection,
  renderUploadSection,
  sectionHeader,
  statusDot,
} from 'cli/commands/format-status.ts';

export { formatBytes };

const SOURCE_ORDER: ('claude-code' | 'cursor' | 'codex' | 'gemini-cli')[] = [
  'claude-code',
  'cursor',
  'codex',
  'gemini-cli',
];

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
  serviceManager?: ServiceManager;
  loadConfig?: (path?: string) => Promise<GatewayConfig>;
  currentVersion?: string;
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
    totalBatchesShipped: number;
    totalBytesShipped: number;
    cyclesTotal: number;
    cyclesWithErrors: number;
    cyclesTotalDurationMs: number;
    lastSuccessAt: string | null;
    lastSuccessBatches: number | null;
    lastSuccessBytes: number | null;
  };
  system: {
    daemon: { isRunning: boolean; pid: number | null; startedAt: string | null };
    autoUpgrade: { lastCheckAt: string | null; latestKnownVersion: string | null };
    binaryAge: { installedAt: string | null; days: number | null };
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
          totalBatchesShipped: 0,
          totalBytesShipped: 0,
          cyclesTotal: 0,
          cyclesWithErrors: 0,
          cyclesTotalDurationMs: 0,
          lastSuccessAt: null,
          lastSuccessBatches: null,
          lastSuccessBytes: null,
        },
        system: {
          daemon: { isRunning: false, pid: null, startedAt: null },
          autoUpgrade: { lastCheckAt: null, latestKnownVersion: null },
          binaryAge: { installedAt: null, days: null },
        },
      };
      deps.output.info(JSON.stringify(empty));
      return { exitCode: EXIT_CODE.notInstalled };
    }
    deps.output.info(`Status: ${statusDot('inactive')} not configured`);
    deps.output.info('');
    deps.output.info(`Run ${chalk.cyan('proxai-gateway setup')} to begin.`);
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

  const cyclesTotal = readNumber(buffer, METADATA_KEYS.cyclesTotal);
  const cyclesWithErrors = readNumber(buffer, METADATA_KEYS.cyclesWithErrors);
  const cyclesTotalDurationMs = readNumber(buffer, METADATA_KEYS.cyclesTotalDurationMs);
  const totalBatchesShipped = readNumber(buffer, METADATA_KEYS.uploadTotalBatchesShipped);
  const totalBytesShipped = readNumber(buffer, METADATA_KEYS.uploadTotalBytesShipped);
  const lastSuccessAt = getMetadata(buffer, METADATA_KEYS.uploadLastSuccessAt);
  const lastSuccessBatches = readNumberOrNull(buffer, METADATA_KEYS.uploadLastSuccessBatches);
  const lastSuccessBytes = readNumberOrNull(buffer, METADATA_KEYS.uploadLastSuccessBytes);
  const lastVersionCheckAt = getMetadata(buffer, METADATA_KEYS.lastVersionCheckAt);
  const latestKnownVersion = getMetadata(buffer, METADATA_KEYS.latestKnownVersion);

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

  const now = (deps.now ?? ((): Date => new Date()))();

  let cfg: GatewayConfig | null = null;
  if (deps.loadConfig !== undefined) {
    try {
      cfg = await deps.loadConfig(deps.configPath);
    } catch {
      cfg = null;
    }
  } else {
    try {
      cfg = await loadConfigFromFile(deps.configPath);
    } catch {
      cfg = null;
    }
  }

  let runtime: { isRunning: boolean; pid: number | null; startedAt: Date | null } = {
    isRunning: false,
    pid: null,
    startedAt: null,
  };
  if (deps.serviceManager !== undefined) {
    try {
      const isRunning = await deps.serviceManager.isRunning();
      const info = await deps.serviceManager.runtimeInfo();
      runtime = { isRunning, pid: info.pid, startedAt: info.startedAt };
    } catch {
      runtime = { isRunning: false, pid: null, startedAt: null };
    }
  }

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
    const installedAt = cfg?.account.installedAt ?? null;
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
        totalBatchesShipped,
        totalBytesShipped,
        cyclesTotal,
        cyclesWithErrors,
        cyclesTotalDurationMs,
        lastSuccessAt,
        lastSuccessBatches,
        lastSuccessBytes,
      },
      system: {
        daemon: {
          isRunning: runtime.isRunning,
          pid: runtime.pid,
          startedAt: runtime.startedAt === null ? null : runtime.startedAt.toISOString(),
        },
        autoUpgrade: { lastCheckAt: lastVersionCheckAt, latestKnownVersion },
        binaryAge: {
          installedAt,
          days: installedAt === null ? null : daysSince(installedAt, now),
        },
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
    cyclesTotal,
    cyclesTotalDurationMs,
    totalBatchesShipped,
    totalBytesShipped,
    lastSuccessAt,
    lastSuccessBatches,
    lastSuccessBytes,
    lastVersionCheckAt,
    latestKnownVersion,
    runtime,
    cfg,
    now,
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
  cyclesTotal: number;
  cyclesTotalDurationMs: number;
  totalBatchesShipped: number;
  totalBytesShipped: number;
  lastSuccessAt: string | null;
  lastSuccessBatches: number | null;
  lastSuccessBytes: number | null;
  lastVersionCheckAt: string | null;
  latestKnownVersion: string | null;
  runtime: { isRunning: boolean; pid: number | null; startedAt: Date | null };
  cfg: GatewayConfig | null;
  now: Date;
}

function renderHumanStatus(deps: StatusCommandDeps, input: RenderInput): void {
  const out = deps.output;
  const dot = statusDot(input.health);
  const label = renderHealthLabel(input);
  out.info(`Status: ${dot} ${label}`);

  renderSentinelLines(out, input);

  out.info('');
  out.info(sectionHeader('Capture'));
  for (const app of SOURCE_ORDER) {
    const cap = input.daemonState?.lastSourceCaptures[app];
    out.info(
      renderCaptureRow({
        name: app,
        capturedBatches: cap?.capturedBatches ?? 0,
        filesProcessed: cap?.filesProcessed ?? 0,
        errorsCount: cap?.errorsCount ?? 0,
      }),
    );
  }

  out.info('');
  const softPause = input.cfg?.capture.bufferSoftPauseBytes ?? 700 * 1024 * 1024;
  for (const line of renderBufferSection({
    pendingCount: input.counts.pending,
    pendingBytes: input.pendingBytes,
    failedCount: input.counts.failed,
    failedBytes: input.failedBytes,
    receiptsCount: input.counts.delivered,
    pressurePendingBytes: input.pendingBytes,
    pressureSoftPauseBytes: softPause,
    lastPruneAt: input.lastPruneAt,
    pendingBySource: input.sourceCounts,
    now: input.now,
  })) {
    out.info(line);
  }

  out.info('');
  for (const line of renderUploadSection({
    totalBatchesShipped: input.totalBatchesShipped,
    totalBytesShipped: input.totalBytesShipped,
    cyclesTotal: input.cyclesTotal,
    cyclesTotalDurationMs: input.cyclesTotalDurationMs,
    lastCycleCompletedAt: input.daemonState?.lastCycleCompletedAt ?? null,
    lastCycleAttempted: input.daemonState?.lastDrainAttempted ?? null,
    lastCycleAccepted: input.daemonState?.lastDrainAccepted ?? null,
    lastCycleRetriable: input.daemonState?.lastDrainRetriable ?? null,
    lastCycleFatal: input.daemonState?.lastDrainFatal ?? null,
    lastSuccessAt: input.lastSuccessAt,
    lastSuccessBatches: input.lastSuccessBatches,
    lastSuccessBytes: input.lastSuccessBytes,
    now: input.now,
  })) {
    out.info(line);
  }

  if (input.daemonState !== null && input.daemonState.lastUploadError !== null) {
    out.info(`  Last error    ${chalk.red(input.daemonState.lastUploadError)}`);
  }
  if (input.daemonState !== null && input.daemonState.lastConsecutiveRetriableBreak === true) {
    out.info(
      `  ${chalk.yellow('Drain backed off after consecutive retriable failures; will retry next cycle')}`,
    );
  }

  const installSource: InstallSource | null = input.cfg?.account.installSource ?? null;
  out.info('');
  for (const line of renderHealthSection({
    daemon: {
      isRunning: input.runtime.isRunning,
      pid: input.runtime.pid,
      startedAt: input.runtime.startedAt,
      now: input.now,
      installSource,
    },
    sentinels: {
      paused: input.paused,
      authFailed: input.authFailed,
      bufferFull: input.bufferFull,
      sessionStopped: input.sessionStopped,
      updateAvailable: input.updateAvailable !== null,
    },
    autoUpgrade: {
      lastCheckAt: input.lastVersionCheckAt,
      currentVersion:
        input.cfg !== null ? (deps.currentVersion ?? '') : (deps.currentVersion ?? ''),
      latestKnownVersion: input.latestKnownVersion,
      installSource,
      updateAvailableSentinelPresent: input.updateAvailable !== null,
      now: input.now,
    },
    binaryAge: {
      installedAt: input.cfg?.account.installedAt ?? null,
      warnAfterDays: input.cfg?.staleBinary.warnAfterDays ?? 90,
      pauseAfterDays: input.cfg?.staleBinary.pauseAfterDays ?? 180,
      now: input.now,
    },
  })) {
    out.info(line);
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

function readNumber(db: Database, key: string): number {
  const raw = getMetadata(db, key);
  if (raw === null) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function readNumberOrNull(db: Database, key: string): number | null {
  const raw = getMetadata(db, key);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function daysSince(iso: string, now: Date): number | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const diff = Math.floor((now.getTime() - ms) / 86_400_000);
  return diff < 0 ? 0 : diff;
}
