import chalk from 'chalk';

import type { OutputSink } from 'cli/cli.types.ts';
import { dim } from 'cli/commands/status/render/format-helpers.ts';
import { renderHumanStatus } from 'cli/commands/status/render-human.ts';
import type { RenderInputs } from 'cli/commands/status/render/render.types.ts';
import type { StatusCommandDeps } from 'cli/commands/status/status.types.ts';

const HEADER_LABEL = '  proxai-gateway';
const DEV_BADGE = chalk.bgYellow.black(' DEV MODE ');
const FOOTER_HINT = '  Press q or Esc to quit';

export function renderFullStatus(inputs: RenderInputs, deps: StatusCommandDeps): string {
  const lines: string[] = [];
  lines.push(renderHeaderLine(inputs));
  if (inputs.isDevMode) {
    lines.push(renderDevBanner(inputs));
  }
  lines.push('');
  lines.push(renderSummaryLine(inputs));
  if (inputs.summary.hint !== null) {
    lines.push(`  ${dim(inputs.summary.hint)}`);
  }
  lines.push('');
  if (inputs.snapshot !== null) {
    const sink = makeStringSink();
    renderHumanStatus({ ...deps, output: sink.out }, inputs.snapshot, { skipTopBanner: true });
    lines.push(...sink.lines);
  }
  lines.push('');
  lines.push(dim(FOOTER_HINT));
  return lines.join('\n');
}

function renderHeaderLine(inputs: RenderInputs): string {
  const version = inputs.version !== null ? ` ${dim(`v${inputs.version}`)}` : '';
  const dev = inputs.isDevMode ? ` ${DEV_BADGE}` : '';
  const ts = dim(formatLocalDateTime(inputs.nowLocal));
  return `${HEADER_LABEL}${version}${dev}    ${ts}`;
}

function renderDevBanner(inputs: RenderInputs): string {
  const ingest = inputs.snapshot?.cfg?.backend.ingestUrl ?? null;
  const backend = ingest === null ? '' : `  ${dim('backend:')} ${chalk.cyan(ingest)}`;
  return `  ${chalk.yellow('⚠  DEV MODE')}  ${dim('running local build outside the OS service manager')}${backend}`;
}

function renderSummaryLine(inputs: RenderInputs): string {
  const glyph = glyphForLevel(inputs.summary.level);
  const color = colorForLevel(inputs.summary.level);
  return `  ${glyph} ${color(inputs.summary.headline)}`;
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

interface StringSink {
  readonly lines: string[];
  readonly out: OutputSink;
}

function makeStringSink(): StringSink {
  const lines: string[] = [];
  const push = (s: string): void => {
    for (const ln of s.split('\n')) lines.push(ln);
  };
  const out: OutputSink = {
    info: push,
    warn: push,
    error: push,
    success: push,
  };
  return { lines, out };
}
