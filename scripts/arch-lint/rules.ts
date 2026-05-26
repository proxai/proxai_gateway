import type { RuleCheck } from 'scripts/arch-lint/arch-lint.types.ts';

const BUN_SQLITE_ALLOWED_PREFIXES = [
  'src/services/buffer/',
  'src/core/io/sqlite/',
  'src/sources/cursor/',
  'src/sources/codex/',
];

const PROCESS_PLATFORM_ALLOWED_FILES = new Set([
  'src/main.ts',
  'src/cli/commands/inspect/report.ts',
]);

const PROCESS_PLATFORM_ALLOWED_PREFIXES = [
  'src/cli/wiring/',
  'src/core/io/',
  'src/core/log/',
  'src/core/system/',
];

function isTestFile(filepath: string): boolean {
  return (
    filepath.endsWith('.test.ts') || filepath.endsWith('.spec.ts') || filepath.includes('/tests/')
  );
}

function hasPrefix(filepath: string, prefixes: readonly string[]): boolean {
  for (const p of prefixes) {
    if (filepath.startsWith(p)) return true;
  }
  return false;
}

export const RULES: readonly RuleCheck[] = [
  {
    rule: 'no-bun-sqlite-runtime-import-outside-buffer',
    applies: (filepath) =>
      !isTestFile(filepath) && !hasPrefix(filepath, BUN_SQLITE_ALLOWED_PREFIXES),
    match: (line) => {
      if (!/from\s+['"]bun:sqlite['"]/.test(line)) return false;
      if (/import\s+type\s+/.test(line)) return false;
      return true;
    },
  },
  {
    rule: 'no-inline-process-platform-comparison',
    applies: (filepath) =>
      !isTestFile(filepath) &&
      !PROCESS_PLATFORM_ALLOWED_FILES.has(filepath) &&
      !hasPrefix(filepath, PROCESS_PLATFORM_ALLOWED_PREFIXES),
    match: (line) =>
      /process\.platform\s*(===|!==|==|!=)/.test(line) ||
      /switch\s*\(\s*process\.platform\s*\)/.test(line),
  },
  {
    rule: 'no-direct-bun-write-to-sentinel',
    applies: (filepath) =>
      !isTestFile(filepath) &&
      !filepath.startsWith('src/core/io/fs/') &&
      !filepath.startsWith('src/services/polling/'),
    match: (line) =>
      /Bun\.write\([^,]*(PAUSED|AUTH_FAILED|BUFFER_FULL|SESSION_STOPPED|UPDATE_AVAILABLE|CONSENT_ACCEPTED)/.test(
        line,
      ),
  },
];
