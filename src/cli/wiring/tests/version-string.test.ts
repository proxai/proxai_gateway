import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildVersionString } from 'cli/wiring/version-string.ts';

test('buildVersionString: includes version and falls back to unknown source when no config', () => {
  const result = buildVersionString({
    version: '2026.5.8',
    installSourcePath: '/nonexistent/proxai-gateway/config.toml',
  });
  expect(result).toContain('2026.5.8');
  expect(result).toContain('unknown');
});

test('buildVersionString: parses install_source from a valid config file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'proxai-version-'));
  try {
    const cfgPath = join(dir, 'config.toml');
    await writeFile(cfgPath, '[account]\ninstall_source = "brew"\n', 'utf8');
    const result = buildVersionString({ version: '2026.5.8', installSourcePath: cfgPath });
    expect(result).toContain('2026.5.8');
    expect(result).toContain('brew');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
