import type { Command } from 'commander';
import type { CLIContext } from 'cli/program/context.ts';
import { runRedactionList, runRedactionTest } from 'cli/commands/redaction.ts';
import {
  buildRedactionListDeps,
  buildRedactionListOptions,
  buildRedactionTestDeps,
  buildRedactionTestOptions,
} from 'cli/wiring/redaction-deps.ts';

export function registerRedactionCommands(program: Command, _ctx: CLIContext): void {
  const redaction = program
    .command('redaction')
    .description(
      'Inspect the on-device secret-redaction rules and try them against a sample file.',
    );

  redaction
    .command('test <file>')
    .description(
      'Run the full redaction pipeline against a local file and print what would be uploaded. The file is never sent anywhere; this is a local-only dry run.',
    )
    .option(
      '--show-rules',
      'after the redacted output, print a summary of which rules matched and how many times',
      false,
    )
    .action(async (filePath: string, opts: { showRules?: boolean }) => {
      const result = await runRedactionTest(
        buildRedactionTestDeps(),
        buildRedactionTestOptions(filePath, opts),
      );
      process.exit(result.exitCode);
    });

  redaction
    .command('list')
    .description(
      'List the active redaction rules grouped by category (e.g. llm-providers, cloud-providers, communication).',
    )
    .option('--categories', 'show only the category names and a rule count per category', false)
    .option('--category <name>', 'restrict the listing to one category (full per-rule detail)')
    .option(
      '--json',
      'emit raw JSON instead of the pretty table format (useful for piping to jq)',
      false,
    )
    .action((opts: { categories?: boolean; category?: string; json?: boolean }) => {
      const result = runRedactionList(buildRedactionListDeps(), buildRedactionListOptions(opts));
      process.exit(result.exitCode);
    });
}
