import type {
  RedactionListCommandDeps,
  RedactionListCommandOptions,
  RedactionTestCommandDeps,
  RedactionTestCommandOptions,
} from 'cli/commands/redaction.ts';
import { consoleOutput } from 'cli/output.ts';

export function buildRedactionTestDeps(): RedactionTestCommandDeps {
  return {
    output: consoleOutput(),
    emit: (line) => console.log(line),
  };
}

export function buildRedactionListDeps(): RedactionListCommandDeps {
  return {
    output: consoleOutput(),
    emit: (line) => console.log(line),
  };
}

export function buildRedactionTestOptions(
  filePath: string,
  opts: { showRules?: boolean },
): RedactionTestCommandOptions {
  const result: RedactionTestCommandOptions = { filePath };
  if (opts.showRules === true) result.showRules = true;
  return result;
}

export function buildRedactionListOptions(opts: {
  categories?: boolean;
  category?: string;
  json?: boolean;
}): RedactionListCommandOptions {
  const result: RedactionListCommandOptions = {};
  if (opts.categories === true) result.categories = true;
  if (opts.category !== undefined) result.category = opts.category;
  if (opts.json === true) result.json = true;
  return result;
}
