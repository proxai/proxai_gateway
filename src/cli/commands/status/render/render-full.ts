import chalk from 'chalk';

import { dim } from 'cli/commands/status/render/format-helpers.ts';
import { inferDaemonAlive } from 'cli/commands/status/daemon-liveness.ts';
import {
  renderBufferSection,
  renderCaptureSection,
  renderHealthSection,
  renderHistorySection,
  renderUploadSection,
} from 'cli/commands/status/render/render-sections.ts';
import type { RenderInputs } from 'cli/commands/status/render/render.types.ts';
import type { StatusCommandDeps } from 'cli/commands/status/status.types.ts';

const HEADER_LABEL = 'proxai-gateway';
const DEV_BADGE = chalk.bgYellow.black(' DEV MODE ');
const LOCAL_BUILD_BADGE = chalk.bgCyan.black(' LOCAL BUILD ');
const FOOTER_HINT = 'Press q or Esc to quit';

export function renderFullStatus(inputs: RenderInputs, deps: StatusCommandDeps): string {
  const lines: string[] = [];
  lines.push(renderHeaderLine(inputs));
  if (inputs.isDevMode || inputs.isLocalBuild) {
    lines.push(...renderDevBanner(inputs));
  }
  lines.push('');
  lines.push(renderSummaryLine(inputs));
  if (inputs.summary.hint !== null) {
    lines.push(`     ${dim(inputs.summary.hint)}`);
  }
  if (inputs.snapshot !== null) {
    lines.push(...renderCaptureSection(inputs.snapshot));
    lines.push(...renderBufferSection(inputs.snapshot));
    lines.push(...renderUploadSection(inputs.snapshot));
    lines.push(...renderHistorySection(inputs.snapshot));
    const inferredAlive = inferDaemonAlive(
      inputs.snapshot.drainLastCycleAt,
      inputs.snapshot.captureLastCycleAt,
      inputs.snapshot.now,
    );
    lines.push(
      ...renderHealthSection({
        s: inputs.snapshot,
        currentVersion: deps.currentVersion ?? '',
        inferredAlive,
        isDevLike: inputs.isDevMode || inputs.isLocalBuild,
      }),
    );
  }
  lines.push('');
  lines.push(`  ${dim(FOOTER_HINT)}`);
  return lines.join('\n');
}

function renderHeaderLine(inputs: RenderInputs): string {
  const version = inputs.version !== null ? ` ${dim(`v${inputs.version}`)}` : '';
  const dev = inputs.isDevMode ? ` ${DEV_BADGE}` : '';
  const local = inputs.isLocalBuild ? ` ${LOCAL_BUILD_BADGE}` : '';
  const ts = dim(formatLocalDateTime(inputs.nowLocal));
  return `  ${chalk.bold(HEADER_LABEL)}${version}${dev}${local}    ${ts}`;
}

function renderDevBanner(inputs: RenderInputs): string[] {
  const lines: string[] = [];
  const ingest = inputs.snapshot?.cfg?.backend.ingestUrl ?? null;
  if (inputs.isLocalBuild) {
    const path =
      inputs.binaryPath !== null ? `  ${dim('binary:')} ${chalk.cyan(inputs.binaryPath)}` : '';
    lines.push(
      `  ${chalk.cyan('▸ LOCAL BUILD')}  ${dim('running outside the OS service manager')}${path}`,
    );
  }
  if (inputs.isDevMode) {
    const backend = ingest === null ? '' : `  ${dim('backend:')} ${chalk.cyan(ingest)}`;
    lines.push(
      `  ${chalk.yellow('⚠ DEV MODE')}    ${dim('localhost backend sentinel active')}${backend}`,
    );
  } else if (inputs.isLocalBuild && ingest !== null) {
    lines.push(`  ${' '.repeat(15)}${dim('backend:')} ${chalk.cyan(ingest)}`);
  }
  return lines;
}

function renderSummaryLine(inputs: RenderInputs): string {
  const glyph = glyphForLevel(inputs.summary.level);
  const color = colorForLevel(inputs.summary.level);
  return `  ${glyph} ${chalk.bold(color(inputs.summary.headline))}`;
}

function formatLocalDateTime(d: Date): string {
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return `${d.getFullYear().toString()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function glyphForLevel(level: RenderInputs['summary']['level']): string {
  if (level === 'ok') return chalk.green('●');
  if (level === 'warning') return chalk.yellow('●');
  if (level === 'error') return chalk.red('●');
  return dim('●');
}

function colorForLevel(level: RenderInputs['summary']['level']): (s: string) => string {
  if (level === 'ok') return chalk.green;
  if (level === 'warning') return chalk.yellow;
  if (level === 'error') return chalk.red;
  return dim;
}
