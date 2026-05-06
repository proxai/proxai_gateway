import chalk from 'chalk';

import { EXIT_CODE } from 'cli/cli.constants.ts';
import type { CommandResult, OutputSink } from 'cli/cli.types.ts';
import { ALL_RULES, applyRedaction, RULE_CATEGORIES } from 'services/redaction';
import type { RedactionRule, RuleCategory } from 'services/redaction';

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

export interface RedactionListCommandDeps {
  output: OutputSink;
  emit: (line: string) => void;
}

export interface RedactionListCommandOptions {
  categories?: boolean;
  category?: string;
  json?: boolean;
}

export function runRedactionList(
  deps: RedactionListCommandDeps,
  options: RedactionListCommandOptions = {},
): CommandResult {
  const emit = deps.emit;

  if (options.json === true) {
    emitJson(emit, options);
    return { exitCode: EXIT_CODE.ok };
  }

  if (options.categories === true) {
    emitCategorySummary(emit);
    return { exitCode: EXIT_CODE.ok };
  }

  if (options.category !== undefined) {
    const target = RULE_CATEGORIES.find((c) => c.name === options.category);
    if (target === undefined) {
      const valid = RULE_CATEGORIES.map((c) => c.name).join(', ');
      deps.output.error(`unknown category: ${options.category}. Valid categories: ${valid}`);
      return { exitCode: EXIT_CODE.validationError };
    }
    emitCategoryDetail(emit, target);
    return { exitCode: EXIT_CODE.ok };
  }

  for (const category of RULE_CATEGORIES) {
    emitCategoryDetail(emit, category);
    emit('');
  }
  emit(
    `Total: ${ALL_RULES.length.toString()} rules across ${RULE_CATEGORIES.length.toString()} categories`,
  );
  return { exitCode: EXIT_CODE.ok };
}

function emitCategorySummary(emit: (line: string) => void): void {
  for (const category of RULE_CATEGORIES) {
    const count = `${category.rules.length.toString()} rules`.padEnd(10);
    emit(
      `${chalk.bold.cyan(category.name.padEnd(22))} ${chalk.dim(count)} ${category.description}`,
    );
  }
  emit('');
  emit(
    `Total: ${ALL_RULES.length.toString()} rules across ${RULE_CATEGORIES.length.toString()} categories`,
  );
}

function emitCategoryDetail(emit: (line: string) => void, category: RuleCategory): void {
  emit(
    `${chalk.bold.cyan(category.name)}  ${chalk.dim(`(${category.rules.length.toString()} rules)`)}`,
  );
  emit(chalk.dim('─'.repeat(70)));
  for (const rule of category.rules) {
    emitRule(emit, rule);
    emit('');
  }
}

function emitRule(emit: (line: string) => void, rule: RedactionRule): void {
  emit(`  ${chalk.green(rule.id)}`);
  emit(`    ${rule.description}`);
  emit(
    `    ${chalk.yellow(rule.pattern.toString())}  ${chalk.dim('→')}  ${chalk.magenta(rule.replacement)}`,
  );
}

function emitJson(emit: (line: string) => void, options: RedactionListCommandOptions): void {
  if (options.categories === true) {
    const summary = RULE_CATEGORIES.map((c) => ({
      name: c.name,
      description: c.description,
      rule_count: c.rules.length,
    }));
    emit(
      JSON.stringify(
        {
          total_rules: ALL_RULES.length,
          category_count: RULE_CATEGORIES.length,
          categories: summary,
        },
        null,
        2,
      ),
    );
    return;
  }

  const categories =
    options.category !== undefined
      ? RULE_CATEGORIES.filter((c) => c.name === options.category)
      : RULE_CATEGORIES;

  emit(
    JSON.stringify(
      {
        total_rules: categories.flatMap((c) => c.rules).length,
        category_count: categories.length,
        categories: categories.map((c) => ({
          name: c.name,
          description: c.description,
          rule_count: c.rules.length,
          rules: c.rules.map((r) => ({
            id: r.id,
            description: r.description,
            pattern: r.pattern.toString(),
            replacement: r.replacement,
          })),
        })),
      },
      null,
      2,
    ),
  );
}
