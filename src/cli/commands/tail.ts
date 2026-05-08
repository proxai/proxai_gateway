import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import chalk from 'chalk';

import { STRUCTURED_LOG_BASENAME, STRUCTURED_LOG_EXTENSION, VALID_LOG_LEVELS } from 'core/log';
import type { LogLevel } from 'core/log';
import { EXIT_CODE } from 'cli/cli.constants.ts';
import type { CommandResult, OutputSink } from 'cli/cli.types.ts';

const PINO_LEVEL_NUMBER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

const PINO_LEVEL_LABEL: Record<number, string> = {
  10: 'TRACE',
  20: 'DEBUG',
  30: 'INFO',
  40: 'WARN',
  50: 'ERROR',
  60: 'FATAL',
};

const POLL_INTERVAL_MS = 200;

export interface TailCommandDeps {
  output: OutputSink;
  logDir: string;
  abortSignal?: AbortSignal;
  emit: (line: string) => void;

  pathProvider?: () => string;

  pollIntervalMs?: number;
}

export interface TailCommandOptions {
  lines?: number;
  follow?: boolean;
  source?: string;
  level?: LogLevel;
  since?: string;
  raw?: boolean;
}

interface ResolvedFilters {
  source: string | null;
  minLevel: number;
  sinceMs: number | null;
}

export async function runTail(
  deps: TailCommandDeps,
  options: TailCommandOptions = {},
): Promise<CommandResult> {
  const filters = resolveFilters(options);
  if (filters === null) {
    deps.output.error('invalid --since duration (use formats like 1h, 30m, 24h, 7d, 60s)');
    return { exitCode: EXIT_CODE.validationError };
  }
  if (options.level !== undefined && !VALID_LOG_LEVELS.includes(options.level)) {
    deps.output.error(`invalid --level: must be one of ${VALID_LOG_LEVELS.join(', ')}`);
    return { exitCode: EXIT_CODE.validationError };
  }

  const lineLimit = options.lines ?? 50;
  const raw = options.raw === true;
  const emit = deps.emit;

  const resolvePath = deps.pathProvider ?? ((): string => todaysLogPath(deps.logDir));
  let path = resolvePath();
  let position = 0;

  const initialExists = await Bun.file(path).exists();
  if (!initialExists) {
    if (options.follow === true) {
      deps.output.info(chalk.dim('Waiting for daemon to start writing logs...'));
    } else if (!raw) {
      deps.output.info(chalk.dim('No logs yet. Start the daemon with `proxai-gateway start`.'));
    }
  }

  const initial = await readMatchingTail(path, lineLimit, filters);
  position = initial.endPosition;
  for (const line of initial.lines) {
    emit(raw ? line : formatLine(line));
  }

  if (options.follow !== true) {
    return { exitCode: EXIT_CODE.ok };
  }

  const pollIntervalMs = deps.pollIntervalMs ?? POLL_INTERVAL_MS;
  let logArrivedNotified = initialExists;
  while (deps.abortSignal === undefined || !deps.abortSignal.aborted) {
    await sleep(pollIntervalMs, deps.abortSignal);
    if (deps.abortSignal !== undefined && deps.abortSignal.aborted) break;

    const currentPath = resolvePath();
    if (currentPath !== path) {
      path = currentPath;
      position = 0;
      logArrivedNotified = false;
    }

    if (!logArrivedNotified) {
      const exists = await Bun.file(path).exists();
      if (!exists) continue;
      deps.output.info(chalk.dim('Log file appeared; streaming...'));
      logArrivedNotified = true;
    }

    const next = await readMatchingFrom(path, position, filters);
    position = next.endPosition;
    for (const line of next.lines) {
      emit(raw ? line : formatLine(line));
    }
  }

  return { exitCode: EXIT_CODE.ok };
}

function resolveFilters(options: TailCommandOptions): ResolvedFilters | null {
  const source = options.source ?? null;
  const minLevel =
    options.level !== undefined && VALID_LOG_LEVELS.includes(options.level)
      ? PINO_LEVEL_NUMBER[options.level]
      : PINO_LEVEL_NUMBER.trace;
  let sinceMs: number | null = null;
  if (options.since !== undefined) {
    const parsed = parseSinceDuration(options.since);
    if (parsed === null) return null;
    sinceMs = Date.now() - parsed;
  }
  return { source, minLevel, sinceMs };
}

function parseSinceDuration(input: string): number | null {
  const match = /^(\d+)([smhd])$/.exec(input.trim());
  if (match === null) return null;
  const value = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(value) || value < 0) return null;
  const multiplier =
    unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return value * multiplier;
}

export function todaysLogPath(logDir: string): string {
  const date = new Date().toISOString().slice(0, 10);
  return join(logDir, `${STRUCTURED_LOG_BASENAME}.${date}.1${STRUCTURED_LOG_EXTENSION}`);
}

interface ReadResult {
  lines: string[];
  endPosition: number;
}

async function readMatchingTail(
  path: string,
  limit: number,
  filters: ResolvedFilters,
): Promise<ReadResult> {
  const file = Bun.file(path);
  if (!(await file.exists())) return { lines: [], endPosition: 0 };
  const text = await file.text();
  const allLines = text.split('\n').filter((l) => l.length > 0);
  const matching: string[] = [];
  for (const line of allLines) {
    if (lineMatches(line, filters)) matching.push(line);
  }
  const tail = matching.slice(-limit);
  return { lines: tail, endPosition: text.length };
}

async function readMatchingFrom(
  path: string,
  fromPosition: number,
  filters: ResolvedFilters,
): Promise<ReadResult> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return { lines: [], endPosition: fromPosition };
  }
  if (size <= fromPosition) return { lines: [], endPosition: fromPosition };
  const file = Bun.file(path);
  if (!(await file.exists())) return { lines: [], endPosition: fromPosition };
  const slice = await file.slice(fromPosition, size).text();
  const newLines = slice.split('\n').filter((l) => l.length > 0);
  const matching: string[] = [];
  for (const line of newLines) {
    if (lineMatches(line, filters)) matching.push(line);
  }
  return { lines: matching, endPosition: size };
}

function lineMatches(line: string, filters: ResolvedFilters): boolean {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return false;
  }
  const level = typeof parsed['level'] === 'number' ? parsed['level'] : 30;
  if (level < filters.minLevel) return false;
  if (filters.source !== null && parsed['source_app'] !== filters.source) return false;
  if (filters.sinceMs !== null) {
    const time = typeof parsed['time'] === 'number' ? parsed['time'] : 0;
    if (time < filters.sinceMs) return false;
  }
  return true;
}

export function formatLine(line: string): string {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return line;
  }
  const time = typeof parsed['time'] === 'number' ? parsed['time'] : Date.now();
  const level = typeof parsed['level'] === 'number' ? parsed['level'] : 30;
  const msg = typeof parsed['msg'] === 'string' ? parsed['msg'] : '';
  const sourceApp = typeof parsed['source_app'] === 'string' ? parsed['source_app'] : null;
  const event = typeof parsed['event'] === 'string' ? parsed['event'] : null;

  const timeStr = formatLocalTime(time);
  const levelLabel = PINO_LEVEL_LABEL[level] ?? String(level);
  const levelColored = colorLevel(level, levelLabel.padEnd(5));
  const sourceTag = sourceApp !== null ? chalk.cyan(`[${sourceApp}] `) : '';
  const eventTag = event !== null ? `${chalk.dim(event.padEnd(24))} ` : '';

  const extras = formatExtras(parsed);
  return `${chalk.gray(timeStr)}  ${levelColored}  ${sourceTag}${eventTag}${msg}${extras}`;
}

function formatLocalTime(timeMs: number): string {
  const d = new Date(timeMs);
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  const ss = d.getSeconds().toString().padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function colorLevel(level: number, label: string): string {
  if (level >= 60) return chalk.bgRed.white(label);
  if (level >= 50) return chalk.red(label);
  if (level >= 40) return chalk.yellow(label);
  if (level >= 30) return chalk.green(label);
  if (level >= 20) return chalk.blue(label);
  return chalk.gray(label);
}

const RESERVED_KEYS = new Set([
  'level',
  'time',
  'msg',
  'source_app',
  'event',
  'pid',
  'hostname',
  'service',
  'version',
  'host_id',
]);

function formatExtras(parsed: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (RESERVED_KEYS.has(key)) continue;
    if (value === null || value === undefined) continue;
    const formatted = typeof value === 'string' ? value : JSON.stringify(value);
    parts.push(`${chalk.dim(key)}=${formatted}`);
  }
  if (parts.length === 0) return '';
  return ` ${parts.join(' ')}`;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    function onAbort(): void {
      cleanup();
      resolve();
    }
    function cleanup(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
