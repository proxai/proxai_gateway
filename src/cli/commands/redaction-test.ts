import { EXIT_CODE } from 'cli/cli.constants.ts';
import type { CommandResult, OutputSink } from 'cli/cli.types.ts';
import { applyRedaction } from 'services/redaction';

export interface RedactionTestCommandDeps {
  output: OutputSink;
  emit: (line: string) => void;
}

export interface RedactionTestCommandOptions {
  filePath: string;
  showRules?: boolean;
}

export async function runRedactionTest(
  deps: RedactionTestCommandDeps,
  options: RedactionTestCommandOptions,
): Promise<CommandResult> {
  const file = Bun.file(options.filePath);
  if (!(await file.exists())) {
    deps.output.error(`file not found: ${options.filePath}`);
    return { exitCode: EXIT_CODE.fileUnreadable };
  }

  let text: string;
  try {
    text = await file.text();
  } catch (err) {
    deps.output.error(`failed to read file: ${(err as Error).message}`);
    return { exitCode: EXIT_CODE.fileUnreadable };
  }

  const result = applyRedaction(text);
  const emit = deps.emit;

  if (options.showRules === true) {
    emit(`Rules matched: ${result.matchCount.toString()} redaction(s)`);
    const entries = Object.entries(result.ruleHits).sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) {
      emit('  (no rules matched)');
    } else {
      for (const [ruleId, count] of entries) {
        emit(`  ${ruleId}: ${count.toString()}`);
      }
    }
    emit('');
    emit('--- redacted output ---');
  }

  emit(result.redacted);
  return { exitCode: EXIT_CODE.ok };
}
