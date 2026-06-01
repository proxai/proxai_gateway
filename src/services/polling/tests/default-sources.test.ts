import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { rmRecursive } from 'core/io/fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openInMemoryBufferDb } from 'services/buffer';
import { buildDefaultSources } from 'services/polling';

let dir: string;
let buffer: Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-default-sources-'));
  buffer = openInMemoryBufferDb();
});

afterEach(async () => {
  buffer.close();
  await rmRecursive(dir);
});

test('builds four sources named claude-code, cursor, codex, claude-desktop', () => {
  const sources = buildDefaultSources({
    claudeCodeBaseDir: join(dir, 'cc'),
    cursorBaseDir: join(dir, 'cur'),
    codexBaseDir: join(dir, 'cx'),
    claudeDesktopBaseDir: join(dir, 'cd'),
  });
  expect(sources).toHaveLength(4);
  expect(sources.map((s) => s.name)).toEqual(['claude-code', 'cursor', 'codex', 'claude-desktop']);
});

test('each source poll returns no-op result for empty base dirs', async () => {
  const sources = buildDefaultSources({
    claudeCodeBaseDir: join(dir, 'cc'),
    cursorBaseDir: join(dir, 'cur'),
    codexBaseDir: join(dir, 'cx'),
    claudeDesktopBaseDir: join(dir, 'cd'),
  });
  for (const s of sources) {
    const result = await s.poll({
      buffer,
      gatewayVersion: 'gw-test',
      maxDecompressedBytes: 9 * 1024 * 1024,
    });
    expect(result.filesProcessed).toBe(0);
    expect(result.capturedBatches).toBe(0);
    expect(result.errors).toEqual([]);
  }
});

test('builds with default home paths when no overrides given', () => {
  const sources = buildDefaultSources();
  expect(sources).toHaveLength(4);
  expect(sources.map((s) => s.name)).toContain('claude-code');
  expect(sources.map((s) => s.name)).toContain('codex');
  expect(sources.map((s) => s.name)).toContain('claude-desktop');
});

test('partial overrides leave the other sources at default paths', () => {
  const sources = buildDefaultSources({ codexBaseDir: join(dir, 'codex-only') });
  expect(sources).toHaveLength(4);
});
