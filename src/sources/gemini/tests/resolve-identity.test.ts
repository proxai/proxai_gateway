import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rmRecursive } from 'core/io/fs';
import { nextGenerationSuffix, sha256Hex } from 'core/utils';
import { openInMemoryBufferDb, setCursor } from 'services/buffer';
import type { DiscoveredGeminiFile, GeminiCollectorContext } from 'sources/gemini';
import { resolveGeminiIdentity } from 'sources/gemini/resolve-identity.ts';

let dir: string;
let buffer: Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-test-gemini-identity-'));
  buffer = openInMemoryBufferDb();
});

afterEach(async () => {
  buffer.close();
  await rmRecursive(dir);
}, 30_000);

function makeSourceDb(): Database {
  const db = new Database(':memory:');
  db.run('CREATE TABLE trajectory_meta (cascade_id TEXT)');
  db.run('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER)');
  db.run('CREATE TABLE trajectory_metadata_blob (id TEXT)');
  db.query('INSERT INTO steps (idx, step_type) VALUES (?, ?)').run(0, 14);
  return db;
}

function makeFile(): DiscoveredGeminiFile {
  const sourcePath = join(dir, 'cascade-1.db');
  return {
    sourcePath,
    sourcePathHash: sha256Hex(sourcePath),
    inode: 123,
    sizeBytes: 4096,
    lastModifiedMs: Date.now(),
    sourcePlatform: 'antigravity-cli',
    conversationId: '',
  };
}

function ctx(): GeminiCollectorContext {
  return { buffer, gatewayVersion: 'gw-0.1', maxDecompressedBytes: 8 * 1024 * 1024 };
}

test('returns the unrotated identity when no prior cursor exists', () => {
  const db = makeSourceDb();
  try {
    const file = makeFile();
    const identity = resolveGeminiIdentity(db, file, ctx(), 4096, 4);
    expect(identity.rotated).toBe(false);
    expect(identity.sourcePath).toBe(file.sourcePath);
    expect(identity.sourcePathHash).toBe(file.sourcePathHash);
  } finally {
    db.close();
  }
});

test('returns the unrotated identity when the cursor shows no vacuum', () => {
  const db = makeSourceDb();
  try {
    const file = makeFile();
    setCursor(buffer, {
      sourceApp: 'gemini',
      sourcePathHash: file.sourcePathHash,
      sourcePath: file.sourcePath,
      sourceInode: null,
      watermarkTable: 'steps',
      watermarkEnd: 1,
      lastSeenSizeBytes: 4096,
      lastSeenPageCount: 4,
    });
    const identity = resolveGeminiIdentity(db, file, ctx(), 4096, 4);
    expect(identity.rotated).toBe(false);
  } finally {
    db.close();
  }
});

test('rotates the identity via #gen suffix when a vacuum shrinks the file', () => {
  const db = makeSourceDb();
  try {
    const file = makeFile();
    setCursor(buffer, {
      sourceApp: 'gemini',
      sourcePathHash: file.sourcePathHash,
      sourcePath: file.sourcePath,
      sourceInode: null,
      watermarkTable: 'trajectory_meta',
      watermarkEnd: 1,
      lastSeenSizeBytes: 1_000_000,
      lastSeenPageCount: 200,
    });

    const identity = resolveGeminiIdentity(db, file, ctx(), 4096, 4);
    const expectedPath = nextGenerationSuffix(file.sourcePath);
    expect(identity.rotated).toBe(true);
    expect(identity.sourcePath).toBe(expectedPath);
    expect(identity.sourcePathHash).toBe(sha256Hex(expectedPath));
  } finally {
    db.close();
  }
});

test('skips a table whose cursor lookup throws and continues to the next', () => {
  const db = makeSourceDb();
  const originalQuery = Database.prototype.query;
  let throwOnce = true;
  Database.prototype.query = function (this: Database, sql: string) {
    if (throwOnce && sql.includes('FROM source_cursors')) {
      throwOnce = false;
      throw new Error('injected cursor failure');
    }
    return originalQuery.call(this, sql);
  } as typeof Database.prototype.query;

  try {
    const file = makeFile();
    const identity = resolveGeminiIdentity(db, file, ctx(), 4096, 4);
    expect(identity.rotated).toBe(false);
  } finally {
    Database.prototype.query = originalQuery;
    db.close();
  }
});
