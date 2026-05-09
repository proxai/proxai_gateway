import { VALID_LOG_LEVELS } from 'core/log';
import type { LogLevel } from 'core/log';

import type { ResolvedFilters, TailCommandOptions } from 'cli/commands/tail/tail.types.ts';

export const PINO_LEVEL_NUMBER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

export function resolveFilters(options: TailCommandOptions): ResolvedFilters | null {
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

export function parseSinceDuration(input: string): number | null {
  const match = /^(\d+)([smhd])$/.exec(input.trim());
  if (match === null) return null;
  const value = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(value) || value < 0) return null;
  const multiplier =
    unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return value * multiplier;
}

export function lineMatches(line: string, filters: ResolvedFilters): boolean {
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
