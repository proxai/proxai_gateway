import { EXIT_CODE } from 'cli/cli.constants.ts';
import type { CommandResult, OutputSink } from 'cli/cli.types.ts';
import { applyStage1, applyStage2 } from 'services/redaction';

export interface RedactionTestCommandDeps {
  output: OutputSink;
  emit?: (line: string) => void;
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

  const stage1 = applyStage1(text);
  const stage2 = applyStage2(stage1.redacted);

  const emit = deps.emit ?? ((line: string) => console.log(line));

  if (options.showRules === true) {
    emitRuleSummary(emit, 'Stage 1 (write-time)', stage1.ruleHits, stage1.matchCount);
    emitRuleSummary(emit, 'Stage 2 (upload-time)', stage2.ruleHits, stage2.matchCount);
    const total = stage1.matchCount + stage2.matchCount;
    const ruleCount = Object.keys(stage1.ruleHits).length + Object.keys(stage2.ruleHits).length;
    emit('');
    emit(`Total: ${total.toString()} redaction(s) across ${ruleCount.toString()} rule(s)`);
    emit('');
    emit('--- redacted output ---');
  }

  emit(stage2.redacted);
  return { exitCode: EXIT_CODE.ok };
}

function emitRuleSummary(
  emit: (line: string) => void,
  heading: string,
  ruleHits: Record<string, number>,
  matchCount: number,
): void {
  emit(`${heading}: ${matchCount.toString()} match(es)`);
  const entries = Object.entries(ruleHits).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) {
    emit('  (no rules matched)');
    return;
  }
  for (const [ruleId, count] of entries) {
    emit(`  ${ruleId}: ${count.toString()}`);
  }
}
