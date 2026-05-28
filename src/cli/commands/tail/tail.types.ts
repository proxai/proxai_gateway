import type { LogLevel } from 'core/log';

import type { OutputSink } from 'cli/cli.types.ts';

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
  static?: boolean;
  source?: string;
  level?: LogLevel;
  since?: string;
  raw?: boolean;
}

export interface ResolvedFilters {
  source: string | null;
  minLevel: number;
  sinceMs: number | null;
}
