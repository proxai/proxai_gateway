import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rmRecursive } from 'core/io/fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RULES, scanDirectory } from 'scripts/arch-lint';

let root: string;
let srcDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'proxai-arch-lint-'));
  srcDir = join(root, 'src');
  await mkdir(srcDir, { recursive: true });
});

afterEach(async () => {
  await rmRecursive(root);
});

async function writeSrc(relativePath: string, body: string): Promise<void> {
  const full = join(srcDir, relativePath);
  const parts = relativePath.split('/');
  parts.pop();
  if (parts.length > 0) await mkdir(join(srcDir, parts.join('/')), { recursive: true });
  await writeFile(full, body);
}

test('flags runtime bun:sqlite import in disallowed directories', async () => {
  await writeSrc('services/foo/index.ts', `import { Database } from 'bun:sqlite';\n`);
  const violations = await scanDirectory(root, srcDir, RULES);
  expect(violations.some((v) => v.rule === 'no-bun-sqlite-runtime-import-outside-buffer')).toBe(
    true,
  );
});

test('allows type-only bun:sqlite import anywhere', async () => {
  await writeSrc('services/foo/index.ts', `import type { Database } from 'bun:sqlite';\n`);
  const violations = await scanDirectory(root, srcDir, RULES);
  expect(violations.length).toBe(0);
});

test('allows runtime bun:sqlite import inside services/buffer', async () => {
  await writeSrc('services/buffer/index.ts', `import { Database } from 'bun:sqlite';\n`);
  const violations = await scanDirectory(root, srcDir, RULES);
  expect(violations.length).toBe(0);
});

test('allows runtime bun:sqlite import inside core/io/sqlite', async () => {
  await writeSrc('core/io/sqlite/open.ts', `import { Database } from 'bun:sqlite';\n`);
  const violations = await scanDirectory(root, srcDir, RULES);
  expect(violations.length).toBe(0);
});

test('ignores violations in test files', async () => {
  await writeSrc(
    'services/foo/tests/foo.test.ts',
    `import { Database } from 'bun:sqlite';\nif (process.platform === 'win32') {}\n`,
  );
  const violations = await scanDirectory(root, srcDir, RULES);
  expect(violations.length).toBe(0);
});

test('flags inline process.platform comparison outside allowed scopes', async () => {
  await writeSrc('services/foo/feature.ts', `if (process.platform === 'win32') { return; }\n`);
  const violations = await scanDirectory(root, srcDir, RULES);
  expect(violations.some((v) => v.rule === 'no-inline-process-platform-comparison')).toBe(true);
});

test('flags inline process.platform switch outside allowed scopes', async () => {
  await writeSrc(
    'services/foo/feature.ts',
    `switch (process.platform) { case 'darwin': break; }\n`,
  );
  const violations = await scanDirectory(root, srcDir, RULES);
  expect(violations.some((v) => v.rule === 'no-inline-process-platform-comparison')).toBe(true);
});

test('allows process.platform as a default parameter value (fallback pattern)', async () => {
  await writeSrc(
    'services/foo/feature.ts',
    `export function check(p: NodeJS.Platform = process.platform): void {}\n`,
  );
  const violations = await scanDirectory(root, srcDir, RULES);
  expect(violations.length).toBe(0);
});

test('allows process.platform as a fallback via ?? operator', async () => {
  await writeSrc(
    'services/foo/feature.ts',
    `const platform = deps.platform ?? process.platform;\n`,
  );
  const violations = await scanDirectory(root, srcDir, RULES);
  expect(violations.length).toBe(0);
});

test('allows inline process.platform comparison inside cli/wiring', async () => {
  await writeSrc('cli/wiring/platform.ts', `if (process.platform === 'win32') { return; }\n`);
  const violations = await scanDirectory(root, srcDir, RULES);
  expect(violations.length).toBe(0);
});

test('allows inline process.platform comparison inside main.ts', async () => {
  await writeSrc('main.ts', `if (process.platform === 'win32') { return; }\n`);
  const violations = await scanDirectory(root, srcDir, RULES);
  expect(violations.length).toBe(0);
});

test('flags direct Bun.write to sentinel filenames outside allowed scope', async () => {
  await writeSrc('services/foo/feature.ts', `await Bun.write('/path/AUTH_FAILED', 'reason');\n`);
  const violations = await scanDirectory(root, srcDir, RULES);
  expect(violations.some((v) => v.rule === 'no-direct-bun-write-to-sentinel')).toBe(true);
});

test('allows Bun.write to sentinels inside core/io/fs and services/polling', async () => {
  await writeSrc('core/io/fs/sentinel.ts', `await Bun.write('/path/AUTH_FAILED', 'reason');\n`);
  await writeSrc(
    'services/polling/auth-failed-sentinel.ts',
    `await Bun.write('/path/AUTH_FAILED', 'reason');\n`,
  );
  const violations = await scanDirectory(root, srcDir, RULES);
  expect(violations.length).toBe(0);
});

test('reports line numbers correctly', async () => {
  await writeSrc(
    'services/foo/feature.ts',
    `// line 1\n// line 2\nimport { Database } from 'bun:sqlite';\n// line 4\n`,
  );
  const violations = await scanDirectory(root, srcDir, RULES);
  const v = violations.find((x) => x.rule === 'no-bun-sqlite-runtime-import-outside-buffer');
  expect(v?.line).toBe(3);
});
