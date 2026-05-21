import chalk from 'chalk';

import type { OutputSink } from 'cli/cli.types.ts';
import { formatBytes, formatLocalTimestamp, formatRelative } from 'core/utils';
import {
  DEFAULT_STALE_PAUSE_DAYS,
  DEFAULT_STALE_WARN_DAYS,
  type InstallSource,
} from 'services/config';

import { sectionHeader, statusDot } from 'cli/commands/status/decorators.ts';
import { renderCaptureCyclesLine, renderCaptureRow } from 'cli/commands/status/render-capture.ts';
import { renderBufferSection } from 'cli/commands/status/render-buffer.ts';
import { renderUploadSection } from 'cli/commands/status/render-upload.ts';
import { renderHealthSection } from 'cli/commands/status/render-health.ts';
import type { StatusCommandDeps, StatusSnapshot } from 'cli/commands/status/status.types.ts';

const SOURCE_ORDER: ('claude-code' | 'cursor' | 'codex' | 'gemini-cli')[] = [
  'claude-code',
  'cursor',
  'codex',
  'gemini-cli',
];

export function renderHumanStatus(deps: StatusCommandDeps, snapshot: StatusSnapshot): void {
  const out = deps.output;
  const dot = statusDot(snapshot.health);
  const label = renderHealthLabel(snapshot);
  out.info(`Status: ${dot} ${label}${snapshot.isDevMode ? chalk.cyan(' (dev mode)') : ''}`);

  renderSentinelLines(out, snapshot);

  out.info('');
  out.info(sectionHeader('Capture'));
  for (const app of SOURCE_ORDER) {
    const cap = snapshot.daemonState?.lastSourceCaptures[app];
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
  const softPause = snapshot.cfg?.capture.bufferSoftPauseBytes ?? 700 * 1024 * 1024;
  for (const line of renderBufferSection({
    pendingCount: snapshot.counts.pending,
    pendingBytes: snapshot.pendingBytes,
    failedCount: snapshot.counts.failed,
    failedBytes: snapshot.failedBytes,
    receiptsCount: snapshot.counts.delivered,
    quarantinedCount: snapshot.quarantinedCount,
    pressurePendingBytes: snapshot.pendingBytes,
    pressureSoftPauseBytes: softPause,
    lastPruneAt: snapshot.lastPruneAt,
    bySource: snapshot.sourceCounts,
    now: snapshot.now,
  })) {
    out.info(line);
  }

  out.info(
    `  Cycles        ${renderCaptureCyclesLine(snapshot.captureCyclesTotal, snapshot.captureCyclesWithErrors, snapshot.captureLastCycleAt, snapshot.now)}`,
  );

  out.info('');
  for (const line of renderUploadSection({
    totalBatchesShipped: snapshot.totalBatchesShipped,
    totalBytesShipped: snapshot.totalBytesShipped,
    drainCyclesTotal: snapshot.drainCyclesTotal,
    drainCyclesTotalDurationMs: snapshot.drainCyclesTotalDurationMs,
    shippedBySource: snapshot.shippedBySource,
    lastCycleCompletedAt: snapshot.daemonState?.lastCycleCompletedAt ?? null,
    lastCycleAttempted: snapshot.daemonState?.lastDrainAttempted ?? null,
    lastCycleAccepted: snapshot.daemonState?.lastDrainAccepted ?? null,
    lastCycleRetriable: snapshot.daemonState?.lastDrainRetriable ?? null,
    lastCycleFatal: snapshot.daemonState?.lastDrainFatal ?? null,
    lastSuccessAt: snapshot.lastSuccessAt,
    lastSuccessBatches: snapshot.lastSuccessBatches,
    lastSuccessBytes: snapshot.lastSuccessBytes,
    now: snapshot.now,
  })) {
    out.info(line);
  }

  if (snapshot.daemonState !== null && snapshot.daemonState.lastUploadError !== null) {
    out.info(`  Last error    ${chalk.red(snapshot.daemonState.lastUploadError)}`);
  }
  if (
    snapshot.daemonState !== null &&
    snapshot.daemonState.lastConsecutiveRetriableBreak === true
  ) {
    out.info(
      `  ${chalk.yellow('Drain backed off after consecutive retriable failures; will retry next cycle')}`,
    );
  }

  const installSource: InstallSource | null = snapshot.cfg?.account.installSource ?? null;
  out.info('');
  for (const line of renderHealthSection({
    daemon: {
      isRunning: snapshot.runtime.isRunning,
      pid: snapshot.runtime.pid,
      startedAt: snapshot.runtime.startedAt,
      now: snapshot.now,
      installSource,
    },
    sentinels: {
      paused: snapshot.paused,
      authFailed: snapshot.authFailed,
      bufferFull: snapshot.bufferFull,
      sessionStopped: snapshot.sessionStopped,
      updateAvailable: snapshot.updateAvailable !== null,
    },
    autoUpgrade: {
      lastCheckAt: snapshot.lastVersionCheckAt,
      currentVersion: deps.currentVersion ?? '',
      latestKnownVersion: snapshot.latestKnownVersion,
      installSource,
      updateAvailableSentinelPresent: snapshot.updateAvailable !== null,
      now: snapshot.now,
    },
    binaryAge: {
      installedAt: snapshot.cfg?.account.installedAt ?? null,
      warnAfterDays: snapshot.cfg?.staleBinary.warnAfterDays ?? DEFAULT_STALE_WARN_DAYS,
      pauseAfterDays: snapshot.cfg?.staleBinary.pauseAfterDays ?? DEFAULT_STALE_PAUSE_DAYS,
      now: snapshot.now,
    },
  })) {
    out.info(line);
  }

  if (snapshot.updateAvailable !== null) {
    out.info('');
    out.info(
      `${chalk.cyan('↑')} Update available: ${chalk.bold(snapshot.updateAvailable.latestVersion)} (currently ${snapshot.updateAvailable.currentVersion}) — run ${chalk.cyan('proxai-gateway upgrade')}`,
    );
  }
}

function renderHealthLabel(snapshot: StatusSnapshot): string {
  if (snapshot.authFailed) return chalk.red('auth failed');
  if (snapshot.paused) return chalk.red('paused');
  if (snapshot.bufferFull) return chalk.red('buffer full');
  if (snapshot.sessionStopped) return chalk.red('stopped (session)');
  if (!snapshot.hasRecentActivity) return chalk.dim('starting');
  if (
    snapshot.daemonState !== null &&
    snapshot.daemonState.lastDrainRetriable !== null &&
    snapshot.daemonState.lastDrainRetriable > 0
  ) {
    return chalk.yellow('active (degraded)');
  }
  return chalk.green('active');
}

function renderSentinelLines(out: OutputSink, snapshot: StatusSnapshot): void {
  if (snapshot.authFailed) {
    const reason = snapshot.authFailedReason.length > 0 ? snapshot.authFailedReason : 'unknown';
    let when = '';
    if (snapshot.authFailedDetectedAt.length > 0) {
      when = ` (since ${formatLocalTimestamp(snapshot.authFailedDetectedAt)})`;
    }
    out.info(
      `  ${chalk.red('AUTH_FAILED')}: ${reason}${when} — re-run ${chalk.cyan('proxai-gateway setup')}`,
    );
  }
  if (snapshot.paused) {
    const reason = snapshot.pausedReason.length > 0 ? `: ${snapshot.pausedReason}` : '';
    out.info(
      `  ${chalk.red('PAUSED')}${reason} — run ${chalk.cyan('proxai-gateway resume')} to continue`,
    );
  }
  if (snapshot.bufferFull) {
    const detail =
      snapshot.bufferFullPendingBytes !== null
        ? ` (pending ${formatBytes(snapshot.bufferFullPendingBytes)})`
        : '';
    out.info(
      `  ${chalk.red('BUFFER_FULL')}${detail} — captures paused until pending bytes drop below the resume threshold`,
    );
  }
  if (snapshot.sessionStopped) {
    let when = '';
    if (snapshot.sessionStoppedSetAt !== null && snapshot.sessionStoppedSetAt.length > 0) {
      when = ` (set ${formatRelative(snapshot.sessionStoppedSetAt)})`;
    }
    out.info(
      `  ${chalk.red('SESSION_STOPPED')}${when} — restart with ${chalk.cyan('proxai-gateway start')}`,
    );
  }
}
