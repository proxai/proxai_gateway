import { join } from 'node:path';
import { RULES } from 'scripts/arch-lint/rules.ts';
import { scanDirectory } from 'scripts/arch-lint/scan.ts';

export { RULES } from 'scripts/arch-lint/rules.ts';
export { scanDirectory } from 'scripts/arch-lint/scan.ts';
export type { Violation, RuleCheck } from 'scripts/arch-lint/arch-lint.types.ts';

async function main(): Promise<void> {
  const root = process.cwd();
  const srcDir = join(root, 'src');
  const violations = await scanDirectory(root, srcDir, RULES);
  if (violations.length === 0) {
    process.stdout.write('arch-lint: 0 violations\n');
    return;
  }
  for (const v of violations) {
    process.stdout.write(`${v.file}:${v.line.toString()}: [${v.rule}] ${v.excerpt}\n`);
  }
  process.stdout.write(`\narch-lint: ${violations.length.toString()} violations found\n`);
  process.exit(1);
}

if (import.meta.main) {
  await main();
}
