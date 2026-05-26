import chalk from 'chalk';
import { formatRelative, formatTimeWithRelative } from 'core/utils';
import {
  bold,
  cyan,
  dim,
  formatByteCount,
  formatCount,
  padLabel,
} from 'cli/commands/status/render/format-helpers.ts';
import { renderBasic } from 'cli/commands/status/render/render-basic.ts';
import type { RenderInputs } from 'cli/commands/status/render/render.types.ts';
import type { StatusSnapshot } from 'cli/commands/status/status.types.ts';

const SOURCE_LABEL_WIDTH = 14;
const FIELD_LABEL_WIDTH = 22;

export function renderVerbose(inputs: RenderInputs): string {
  const basic = renderBasic({
    ...inputs,
    snapshot: inputs.snapshot,
  });
  if (inputs.snapshot === null) return basic;
  const sections: string[] = [];
  sections.push(renderBySource(inputs.snapshot));
  sections.push(renderActivity(inputs.snapshot));
  sections.push(renderSentinels(inputs.snapshot));
  sections.push(renderRuntime(inputs.snapshot));
  return [basic, '', ...sections].join('\n');
}

function sectionHeader(label: string): string {
  return `  ${bold(label)}`;
}

function renderBySource(s: StatusSnapshot): string {
  const lines: string[] = [];
  lines.push(sectionHeader('By source'));
  const apps = Object.keys(s.shippedBySource);
  if (apps.length === 0 && Object.keys(s.sourceCounts).length === 0) {
    lines.push(`  ${dim('No source activity yet.')}`);
    return lines.join('\n');
  }
  const universe = new Set<string>([...apps, ...Object.keys(s.sourceCounts)]);
  for (const app of universe) {
    const shipped = s.shippedBySource[app as keyof typeof s.shippedBySource];
    const counts = s.sourceCounts[app as keyof typeof s.sourceCounts];
    const shippedSessions = shipped?.batches ?? 0;
    const shippedBytes = shipped?.bytes ?? 0;
    const pendingSessions = counts?.pending ?? 0;
    const failedSessions = counts?.failed ?? 0;
    lines.push(
      `  ${padLabel(app, SOURCE_LABEL_WIDTH)}${dim('uploaded')} ${formatCount(shippedSessions)} ${dim(`(${formatByteCount(shippedBytes)})`)}  ${dim('pending')} ${formatCount(pendingSessions)}${failedSessions > 0 ? `  ${chalk.red(`failed ${formatCount(failedSessions)}`)}` : ''}`,
    );
  }
  return lines.join('\n');
}

function renderActivity(s: StatusSnapshot): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(sectionHeader('Recent activity'));
  const lastSuccess = s.lastSuccessAt;
  if (lastSuccess !== null) {
    lines.push(
      `  ${padLabel('Last upload:', FIELD_LABEL_WIDTH)}${formatTimeWithRelative(lastSuccess, { now: s.now })}`,
    );
  } else {
    lines.push(`  ${padLabel('Last upload:', FIELD_LABEL_WIDTH)}${dim('never')}`);
  }
  const lastCapture = s.captureLastCycleAt;
  if (lastCapture !== null) {
    lines.push(
      `  ${padLabel('Last capture:', FIELD_LABEL_WIDTH)}${formatTimeWithRelative(lastCapture, { now: s.now })}`,
    );
  }
  if (s.daemonState?.lastUploadError !== null && s.daemonState?.lastUploadError !== undefined) {
    lines.push(
      `  ${padLabel('Last error:', FIELD_LABEL_WIDTH)}${chalk.red(s.daemonState.lastUploadError)}`,
    );
  }
  lines.push(
    `  ${padLabel('Capture cycles:', FIELD_LABEL_WIDTH)}${formatCount(s.captureCyclesTotal)}  ${dim(`(${formatCount(s.captureCyclesWithErrors)} with errors)`)}`,
  );
  lines.push(`  ${padLabel('Drain cycles:', FIELD_LABEL_WIDTH)}${formatCount(s.drainCyclesTotal)}`);
  return lines.join('\n');
}

function renderSentinels(s: StatusSnapshot): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(sectionHeader('Signals'));
  lines.push(
    `  ${padLabel('Auth failure:', FIELD_LABEL_WIDTH)}${formatFlag(s.authFailed, s.authFailedReason)}`,
  );
  lines.push(`  ${padLabel('Paused:', FIELD_LABEL_WIDTH)}${formatFlag(s.paused, s.pausedReason)}`);
  lines.push(`  ${padLabel('Buffer pressure:', FIELD_LABEL_WIDTH)}${formatBufferPressure(s)}`);
  lines.push(
    `  ${padLabel('Session stopped:', FIELD_LABEL_WIDTH)}${formatFlag(s.sessionStopped, '')}`,
  );
  if (s.updateAvailable !== null) {
    lines.push(
      `  ${padLabel('Update available:', FIELD_LABEL_WIDTH)}${cyan(s.updateAvailable.latestVersion)}  ${dim(`(current ${s.updateAvailable.currentVersion})`)}`,
    );
  }
  return lines.join('\n');
}

function renderRuntime(s: StatusSnapshot): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(sectionHeader('Runtime'));
  const running = s.runtime.isRunning;
  lines.push(
    `  ${padLabel('Background service:', FIELD_LABEL_WIDTH)}${running ? chalk.green('running') : dim('stopped')}`,
  );
  if (s.runtime.pid !== null) {
    lines.push(`  ${padLabel('PID:', FIELD_LABEL_WIDTH)}${formatCount(s.runtime.pid)}`);
  }
  if (s.runtime.startedAt !== null) {
    lines.push(
      `  ${padLabel('Started:', FIELD_LABEL_WIDTH)}${formatRelative(s.runtime.startedAt.toISOString(), { now: s.now })}`,
    );
  }
  if (s.lastVersionCheckAt !== null) {
    lines.push(
      `  ${padLabel('Last version check:', FIELD_LABEL_WIDTH)}${formatTimeWithRelative(s.lastVersionCheckAt, { now: s.now })}`,
    );
  }
  return lines.join('\n');
}

function formatFlag(present: boolean, reason: string): string {
  if (!present) return dim('clear');
  if (reason.length === 0) return chalk.yellow('active');
  return `${chalk.yellow('active')} ${dim(`(${reason})`)}`;
}

function formatBufferPressure(s: StatusSnapshot): string {
  if (!s.bufferFull) return dim('ok');
  const pending = s.bufferFullPendingBytes;
  const threshold = s.bufferFullThreshold;
  if (pending === null || threshold === null || threshold === 0) {
    return chalk.yellow('full');
  }
  const pct = Math.min(100, Math.round((pending / threshold) * 100));
  return chalk.yellow(`full (${pct.toString()}%)`);
}
