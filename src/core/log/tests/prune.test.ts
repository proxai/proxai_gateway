import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pruneLogDirectory } from 'core/log';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-test-prune-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function seed(name: string, sizeBytes: number): Promise<void> {
  await writeFile(join(dir, name), 'x'.repeat(sizeBytes));
}

test('returns empty result on empty dir', async () => {
  const result = await pruneLogDirectory(dir);
  expect(result.deletedFiles).toEqual([]);
  expect(result.retainedCount).toBe(0);
  expect(result.retainedBytes).toBe(0);
});

test('returns empty result on missing dir', async () => {
  const result = await pruneLogDirectory(join(dir, 'does-not-exist'));
  expect(result.deletedFiles).toEqual([]);
  expect(result.retainedCount).toBe(0);
});

test('ignores files that do not match the structured.log pattern', async () => {
  await seed('random.txt', 100);
  await seed('not-a-structured-log.log', 200);
  const result = await pruneLogDirectory(dir);
  expect(result.deletedFiles).toEqual([]);
  expect(result.retainedCount).toBe(0);
  const entries = await readdir(dir);
  expect(entries).toContain('random.txt');
});

test('retains files when under both caps', async () => {
  await seed('structured.2026-05-01.1.log', 100);
  await seed('structured.2026-05-02.1.log', 100);
  const result = await pruneLogDirectory(dir, { retentionDays: 5, totalSizeCapBytes: 10_000 });
  expect(result.deletedFiles).toEqual([]);
  expect(result.retainedCount).toBe(2);
  expect(result.retainedBytes).toBe(200);
});

test('deletes oldest files beyond retention day count', async () => {
  await seed('structured.2026-05-01.1.log', 100);
  await seed('structured.2026-05-02.1.log', 100);
  await seed('structured.2026-05-03.1.log', 100);
  await seed('structured.2026-05-04.1.log', 100);
  const result = await pruneLogDirectory(dir, { retentionDays: 2 });
  expect(result.retainedCount).toBe(2);
  expect(result.deletedFiles).toHaveLength(2);
  const remaining = await readdir(dir);
  expect(remaining.sort()).toEqual(['structured.2026-05-03.1.log', 'structured.2026-05-04.1.log']);
});

test('deletes oldest files when total size exceeds cap', async () => {
  await seed('structured.2026-05-01.1.log', 1000);
  await seed('structured.2026-05-02.1.log', 1000);
  await seed('structured.2026-05-03.1.log', 1000);
  const result = await pruneLogDirectory(dir, { retentionDays: 100, totalSizeCapBytes: 1500 });
  expect(result.retainedCount).toBeGreaterThanOrEqual(1);
  expect(result.retainedBytes).toBeLessThanOrEqual(1500);
  const remaining = await readdir(dir);
  expect(remaining).toContain('structured.2026-05-03.1.log');
});

test('keeps at least one file even if it exceeds size cap on its own', async () => {
  await seed('structured.2026-05-01.1.log', 5000);
  const result = await pruneLogDirectory(dir, { retentionDays: 100, totalSizeCapBytes: 100 });
  expect(result.retainedCount).toBe(1);
});

test('day count and size cap work together', async () => {
  for (let day = 1; day <= 10; day++) {
    const ds = day < 10 ? `0${day.toString()}` : day.toString();
    await seed(`structured.2026-05-${ds}.1.log`, 500);
  }
  const result = await pruneLogDirectory(dir, { retentionDays: 7, totalSizeCapBytes: 2000 });
  expect(result.retainedCount).toBeLessThanOrEqual(7);
  expect(result.retainedBytes).toBeLessThanOrEqual(2000);
});

test.skipIf(process.platform === 'win32')(
  'skips matched names whose stat() throws (broken symlink)',
  async () => {
    const { symlink } = await import('node:fs/promises');
    // Create a broken symlink whose name matches the structured-log pattern.
    // readdir will return it but stat() throws ENOENT — the catch should
    // skip it without aborting the scan.
    const linkPath = join(dir, 'structured.2026-05-01.1.log');
    await symlink('/nonexistent/target/path', linkPath);
    await seed('structured.2026-05-02.1.log', 100);
    const result = await pruneLogDirectory(dir, {
      retentionDays: 100,
      totalSizeCapBytes: 100_000,
    });
    // Only the real file remains in retainedCount; the broken symlink is
    // silently skipped during the scan.
    expect(result.retainedCount).toBe(1);
  },
);
