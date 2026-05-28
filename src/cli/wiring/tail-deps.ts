import type { TailCommandDeps, TailCommandOptions } from 'cli/commands/tail';
import { consoleOutput } from 'cli/output.ts';
import type { LogLevel } from 'core/log';

export interface BuildTailDepsInputs {
  logDir: string;
  abortSignal: AbortSignal;
}

export function buildTailDeps(inputs: BuildTailDepsInputs): TailCommandDeps {
  return {
    output: consoleOutput(),
    logDir: inputs.logDir,
    abortSignal: inputs.abortSignal,
    emit: (line) => console.log(line),
  };
}

export function buildTailOptions(opts: {
  lines?: string;
  static?: boolean;
  source?: string;
  level?: string;
  since?: string;
  raw?: boolean;
}): TailCommandOptions {
  const out: TailCommandOptions = {};
  if (opts.lines !== undefined) out.lines = Number(opts.lines);
  if (opts.static === true) out.static = true;
  if (opts.source !== undefined) out.source = opts.source;
  if (opts.level !== undefined) out.level = opts.level as LogLevel;
  if (opts.since !== undefined) out.since = opts.since;
  if (opts.raw === true) out.raw = true;
  return out;
}
