import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { RuleCheck, Violation } from 'scripts/arch-lint/arch-lint.types.ts';

export async function scanDirectory(
  rootDir: string,
  scanDir: string,
  rules: readonly RuleCheck[],
): Promise<Violation[]> {
  const violations: Violation[] = [];
  await walkDir(scanDir, async (absPath) => {
    if (!absPath.endsWith('.ts')) return;
    const relativePath = relative(rootDir, absPath).split(sep).join('/');
    const fileViolations = await scanFile(relativePath, absPath, rules);
    for (const v of fileViolations) violations.push(v);
  });
  return violations;
}

async function scanFile(
  relativePath: string,
  absPath: string,
  rules: readonly RuleCheck[],
): Promise<Violation[]> {
  const applicable = rules.filter((r) => r.applies(relativePath));
  if (applicable.length === 0) return [];
  const body = await readFile(absPath, 'utf8');
  const lines = body.split('\n');
  const violations: Violation[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    for (const rule of applicable) {
      if (rule.match(line)) {
        violations.push({
          file: relativePath,
          line: i + 1,
          rule: rule.rule,
          excerpt: line.trim(),
        });
      }
    }
  }
  return violations;
}

async function walkDir(dir: string, visit: (absPath: string) => Promise<void>): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    const s = await stat(full);
    if (s.isDirectory()) {
      await walkDir(full, visit);
    } else if (s.isFile()) {
      await visit(full);
    }
  }
}
