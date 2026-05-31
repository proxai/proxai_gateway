import chalk from 'chalk';

import { formatBytes, formatLocalTimestamp, formatRelative } from 'core/utils';
import type {
  CaptureLookup,
  FailedRecord,
  LogsCommandOptions,
  LogsFrame,
  PendingRecord,
  QuarantinedRecord,
  UploadedRecord,
} from 'cli/commands/logs/logs.types.ts';

const PROMPT_PREVIEW_MAX = 100;
const DETAIL_INDENT = '              ';

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function timeColumn(iso: string): string {
  return `${formatLocalTimestamp(iso)} (${formatRelative(iso)})`;
}

function promptPreview(prompt: string | null): string {
  if (prompt === null || prompt.trim().length === 0) return chalk.dim('(no prompt captured)');
  return truncate(oneLine(prompt), PROMPT_PREVIEW_MAX);
}

function uploadedStatus(record: UploadedRecord): string {
  return record.idempotentOnServer ? chalk.dim('re-sent') : chalk.green('uploaded');
}

function renderUploadedRow(record: UploadedRecord): string {
  return `${chalk.dim(timeColumn(record.deliveredAt))}  ${chalk.cyan(record.sourceApp)}  ${promptPreview(record.userPrompt)}  ${uploadedStatus(record)}`;
}

function renderFailedRow(record: FailedRecord): string {
  const attempts = chalk.dim(`(${record.attempts.toString()}x)`);
  const error =
    record.lastError !== null ? `  ${chalk.red(truncate(oneLine(record.lastError), 60))}` : '';
  return `${chalk.dim(timeColumn(record.capturedAtUtc))}  ${chalk.yellow(record.sourceApp)}  ${promptPreview(record.userPrompt)}  ${chalk.red('failed')} ${attempts}${error}`;
}

function renderPendingRow(record: PendingRecord): string {
  const attempts = record.attempts > 0 ? chalk.dim(` (${record.attempts.toString()}x)`) : '';
  return `${chalk.dim(timeColumn(record.capturedAtUtc))}  ${chalk.blue(record.sourceApp)}  ${promptPreview(record.userPrompt)}  ${chalk.blue('pending')}${attempts}`;
}

function renderQuarantinedRow(record: QuarantinedRecord): string {
  return `${chalk.dim(timeColumn(record.quarantinedAtUtc))}  ${chalk.magenta(record.sourceApp)}  ${chalk.dim(formatBytes(record.redactedSizeBytes))}  ${chalk.red('quarantined')}  ${chalk.dim(truncate(record.reason, 50))}`;
}

function field(label: string, value: string): string {
  return `  ${chalk.dim(label.padEnd(11))} ${value}`;
}

function textField(label: string, value: string | null, emptyText: string): string {
  if (value === null || value.trim().length === 0) {
    return field(label, chalk.dim(emptyText));
  }
  const indented = value
    .split('\n')
    .map((line, index) => (index === 0 ? line : `${DETAIL_INDENT}${line}`))
    .join('\n');
  return field(label, indented);
}

function watermark(start: number, end: number, kind: string): string {
  return `${start.toString()} → ${end.toString()} (${kind})`;
}

function versions(agent: string | null, gateway: string | null): string {
  return `agent ${agent ?? '—'} · gateway ${gateway ?? '—'}`;
}

function renderUploadedDetail(record: UploadedRecord): string[] {
  return [
    `${chalk.bold(chalk.cyan(record.sourceApp))}  ${chalk.dim(timeColumn(record.deliveredAt))}  ${uploadedStatus(record)}`,
    field('capture_id', chalk.dim(record.captureId)),
    textField('prompt', record.userPrompt, '(no prompt captured)'),
    field('response', chalk.dim('(not retained after upload)')),
    field('source', record.sourcePath ?? chalk.dim('—')),
    field('hash', chalk.dim(record.sourcePathHash)),
    field('watermark', watermark(record.watermarkStart, record.watermarkEnd, record.watermarkKind)),
    field('versions', chalk.dim(versions(record.agentSchemaVersion, record.gatewayVersion))),
    field(
      'bytes',
      chalk.dim(
        `${record.shippedBytes !== null ? formatBytes(record.shippedBytes) : '—'} · attempts ${record.attempts?.toString() ?? '—'}`,
      ),
    ),
  ];
}

function renderFailedDetail(record: FailedRecord): string[] {
  return [
    `${chalk.bold(chalk.yellow(record.sourceApp))}  ${chalk.dim(timeColumn(record.capturedAtUtc))}  ${chalk.red('failed')} ${chalk.dim(`(${record.attempts.toString()}x)`)}`,
    field('capture_id', chalk.dim(record.captureId)),
    textField('prompt', record.userPrompt, '(no prompt found in body)'),
    textField('response', record.assistantResponse, '(no assistant response found in body)'),
    textField('error', record.lastError, '—'),
    field('source', record.sourcePath),
    field('hash', chalk.dim(record.sourcePathHash ?? '—')),
    field('watermark', watermark(record.watermarkStart, record.watermarkEnd, record.watermarkKind)),
    field('versions', chalk.dim(versions(record.agentSchemaVersion, record.gatewayVersion))),
    field('bytes', chalk.dim(formatBytes(record.sizeBytes))),
  ];
}

function renderPendingDetail(record: PendingRecord): string[] {
  return [
    `${chalk.bold(chalk.blue(record.sourceApp))}  ${chalk.dim(timeColumn(record.capturedAtUtc))}  ${chalk.blue('pending')}`,
    field('capture_id', chalk.dim(record.captureId)),
    textField('prompt', record.userPrompt, '(no prompt found in body)'),
    textField('response', record.assistantResponse, '(no assistant response found in body)'),
    field('source', record.sourcePath),
    field('hash', chalk.dim(record.sourcePathHash ?? '—')),
    field('watermark', watermark(record.watermarkStart, record.watermarkEnd, record.watermarkKind)),
    field('versions', chalk.dim(versions(record.agentSchemaVersion, record.gatewayVersion))),
    field('bytes', chalk.dim(formatBytes(record.sizeBytes))),
  ];
}

function renderDetail(detail: CaptureLookup): string[] {
  if (detail.kind === 'uploaded') return renderUploadedDetail(detail.record);
  if (detail.kind === 'failed') return renderFailedDetail(detail.record);
  return renderPendingDetail(detail.record);
}

function renderIdView(frame: LogsFrame): string {
  if (frame.detail === null) {
    return chalk.dim(`No record found for id '${frame.idQuery ?? ''}'.`);
  }
  return renderDetail(frame.detail).join('\n');
}

interface Section<T> {
  readonly title: string;
  readonly rows: readonly T[];
  readonly compact: (row: T) => string;
  readonly detail?: (row: T) => string[];
}

function renderSection<T>(section: Section<T>, verbose: boolean): string[] {
  if (section.rows.length === 0) return [];
  const lines = [section.title];
  for (const row of section.rows) {
    if (verbose && section.detail !== undefined) {
      lines.push(...section.detail(row).map((line) => `  ${line}`));
      lines.push('');
    } else {
      lines.push(`  ${section.compact(row)}`);
    }
  }
  return lines;
}

function emptyMessage(options: LogsCommandOptions): string {
  if (options.failed === true) return 'No failed or quarantined records.';
  if (options.pending === true) return 'No pending records.';
  return 'No uploaded records yet.';
}

export function renderLogsFrame(frame: LogsFrame, options: LogsCommandOptions): string {
  if (frame.idQuery !== null) {
    return renderIdView(frame);
  }

  const verbose = options.verbose === true;
  const lines: string[] = [];

  lines.push(
    ...renderSection(
      {
        title: chalk.bold('Uploaded'),
        rows: frame.uploaded,
        compact: renderUploadedRow,
        detail: renderUploadedDetail,
      },
      verbose,
    ),
  );
  lines.push(
    ...renderSection(
      {
        title: chalk.bold(chalk.yellow('Failed')),
        rows: frame.failed,
        compact: renderFailedRow,
        detail: renderFailedDetail,
      },
      verbose,
    ),
  );
  lines.push(
    ...renderSection(
      {
        title: chalk.bold(chalk.red('Quarantined')),
        rows: frame.quarantined,
        compact: renderQuarantinedRow,
      },
      verbose,
    ),
  );
  lines.push(
    ...renderSection(
      {
        title: chalk.bold(chalk.blue('Pending')),
        rows: frame.pending,
        compact: renderPendingRow,
        detail: renderPendingDetail,
      },
      verbose,
    ),
  );

  if (lines.length === 0) {
    lines.push(chalk.dim(emptyMessage(options)));
  }

  if (options.static !== true && options.json !== true) {
    lines.push('');
    lines.push(`  ${chalk.dim('Press q or Esc to quit')}`);
  }

  return lines.join('\n');
}

export function renderLogsJson(frame: LogsFrame): string {
  return JSON.stringify(frame);
}
