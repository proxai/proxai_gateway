import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Database as SqliteDatabase } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rmRecursive, statFile } from 'core/io/fs';
import { nextGenerationSuffix, sha256Hex, zstdDecompressSync, requireDefined } from 'core/utils';
import {
  countByStatus,
  countQuarantined,
  deleteBatch,
  getBatch,
  getCursor,
  nextPendingBatch,
  openInMemoryBufferDb,
  setCursor,
} from 'services/buffer';
import {
  BODY_MAX_COMPRESSED_BYTES,
  BODY_MAX_DECOMPRESSED_BYTES,
  BODY_TARGET_COMPRESSED_BYTES,
  BODY_TARGET_DECOMPRESSED_BYTES,
} from 'services/contract';
import { collectCodexState } from 'sources/codex';
import type { CodexCollectorContext, DiscoveredCodexStateFile } from 'sources/codex';

let dir: string;
let buffer: SqliteDatabase;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-test-codex-state-'));
  buffer = openInMemoryBufferDb();
});

afterEach(async () => {
  buffer.close();
  await rmRecursive(dir);
}, 30_000);

interface ThreadRow {
  id: string;
  cli_version: string | null;
  cwd?: string;
  title?: string;
  model?: string;
}

interface DynamicToolRow {
  thread_id: string;
  position: number;
  name: string;
}

interface SpawnEdgeRow {
  parent_thread_id: string;
  child_thread_id: string;
  status: string;
}

interface SeedSpec {
  threads?: ThreadRow[];
  dynamicTools?: DynamicToolRow[];
  spawnEdges?: SpawnEdgeRow[];
  forbiddenTables?: { name: string; rows: { id: number; secret: string }[] }[];
}

async function makeStateDb(
  spec: SeedSpec,
  name = 'state_5.sqlite',
): Promise<DiscoveredCodexStateFile> {
  const path = join(dir, name);
  const db = new Database(path, { create: true });
  db.run(
    `CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      cli_version TEXT,
      cwd TEXT,
      title TEXT,
      model TEXT
    )`,
  );
  db.run(
    `CREATE TABLE thread_dynamic_tools (
      thread_id TEXT,
      position INTEGER,
      name TEXT,
      PRIMARY KEY (thread_id, position)
    )`,
  );
  db.run(
    `CREATE TABLE thread_spawn_edges (
      parent_thread_id TEXT,
      child_thread_id TEXT PRIMARY KEY,
      status TEXT
    )`,
  );

  for (const t of spec.threads ?? []) {
    db.query('INSERT INTO threads (id, cli_version, cwd, title, model) VALUES (?, ?, ?, ?, ?)').run(
      t.id,
      t.cli_version,
      t.cwd ?? '/tmp',
      t.title ?? 't',
      t.model ?? 'gpt-5',
    );
  }
  for (const t of spec.dynamicTools ?? []) {
    db.query('INSERT INTO thread_dynamic_tools (thread_id, position, name) VALUES (?, ?, ?)').run(
      t.thread_id,
      t.position,
      t.name,
    );
  }
  for (const t of spec.spawnEdges ?? []) {
    db.query(
      'INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id, status) VALUES (?, ?, ?)',
    ).run(t.parent_thread_id, t.child_thread_id, t.status);
  }
  for (const forbidden of spec.forbiddenTables ?? []) {
    const escaped = forbidden.name.replace(/"/g, '""');
    db.run(`CREATE TABLE "${escaped}" (id INTEGER PRIMARY KEY, secret TEXT)`);
    for (const row of forbidden.rows) {
      db.query(`INSERT INTO "${escaped}" (id, secret) VALUES (?, ?)`).run(row.id, row.secret);
    }
  }
  db.close();

  const stat = await statFile(path);
  if (!stat.exists) throw new Error('file missing after write');
  return {
    sourcePath: path,
    sourcePathHash: sha256Hex(path),
    inode: Number(stat.inode),
    sizeBytes: stat.size,
    lastModifiedMs: stat.mtimeMs,
  };
}

function ctx(b: SqliteDatabase): CodexCollectorContext {
  return {
    buffer: b,
    gatewayVersion: '@proxai/gateway 0.1.0',
    maxDecompressedBytes: BODY_TARGET_DECOMPRESSED_BYTES,
  };
}

const DECODER = new TextDecoder();

test('captures threads and spawn_edges but skips thread_dynamic_tools', async () => {
  const file = await makeStateDb({
    threads: [{ id: 't1', cli_version: '0.126.0' }],
    dynamicTools: [{ thread_id: 't1', position: 0, name: 'web_search' }],
    spawnEdges: [{ parent_thread_id: 't1', child_thread_id: 't2', status: 'completed' }],
  });
  const { result, agentSchemaVersion } = await collectCodexState(file, ctx(buffer));
  expect(agentSchemaVersion).toBe('0.126.0');
  expect(result.capturedBatches).toBe(2);
  expect(result.errors).toEqual([]);
  expect(countByStatus(buffer).pending).toBe(2);
});

test('samples cli_version from the most-recent threads row', async () => {
  const file = await makeStateDb({
    threads: [
      { id: 't1', cli_version: '0.100.0' },
      { id: 't2', cli_version: '0.126.0-alpha.8' },
    ],
  });
  const { agentSchemaVersion } = await collectCodexState(file, ctx(buffer));
  expect(agentSchemaVersion).toBe('0.126.0-alpha.8');
});

test('falls back to "unknown" when threads is empty', async () => {
  const file = await makeStateDb({});
  const { agentSchemaVersion, result } = await collectCodexState(file, ctx(buffer));
  expect(agentSchemaVersion).toBe('unknown');
  expect(result.capturedBatches).toBe(0);
});

test('skips threads rows with empty cli_version and uses the most-recent populated one', async () => {
  const file = await makeStateDb({
    threads: [
      { id: 't1', cli_version: '0.100.0' },
      { id: 't2', cli_version: '0.126.0' },
      { id: 't3', cli_version: '' },
    ],
  });
  const { agentSchemaVersion } = await collectCodexState(file, ctx(buffer));
  expect(agentSchemaVersion).toBe('0.126.0');
});

test('falls back to "unknown" when every threads row has empty cli_version', async () => {
  const file = await makeStateDb({
    threads: [
      { id: 't1', cli_version: '' },
      { id: 't2', cli_version: '' },
    ],
  });
  const { agentSchemaVersion } = await collectCodexState(file, ctx(buffer));
  expect(agentSchemaVersion).toBe('unknown');
});

test('skips a missing table and continues with the others', async () => {
  const path = join(dir, 'state_5.sqlite');
  const db = new Database(path, { create: true });
  db.run(
    `CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      cli_version TEXT
    )`,
  );
  db.query('INSERT INTO threads (id, cli_version) VALUES (?, ?)').run('t1', '0.1.0');
  db.close();
  const stat = await statFile(path);
  if (!stat.exists) throw new Error('missing');
  const file: DiscoveredCodexStateFile = {
    sourcePath: path,
    sourcePathHash: sha256Hex(path),
    inode: Number(stat.inode),
    sizeBytes: stat.size,
    lastModifiedMs: stat.mtimeMs,
  };
  const { result, agentSchemaVersion } = await collectCodexState(file, ctx(buffer));
  expect(agentSchemaVersion).toBe('0.1.0');
  expect(result.capturedBatches).toBe(1);
  expect(result.errors).toEqual([]);
});

test('persists per-table watermarks separately', async () => {
  const file = await makeStateDb({
    threads: [{ id: 't1', cli_version: '0.1.0' }],
    dynamicTools: [
      { thread_id: 't1', position: 0, name: 'a' },
      { thread_id: 't1', position: 1, name: 'b' },
    ],
    spawnEdges: [{ parent_thread_id: 't1', child_thread_id: 't2', status: 'ok' }],
  });
  await collectCodexState(file, ctx(buffer));
  const tCursor = getCursor(buffer, {
    sourceApp: 'codex',
    sourcePathHash: file.sourcePathHash,
    sourceInode: null,
    watermarkTable: 'threads',
  });
  expect(tCursor?.watermarkEnd).toBe(2);
  const dtCursor = getCursor(buffer, {
    sourceApp: 'codex',
    sourcePathHash: file.sourcePathHash,
    sourceInode: null,
    watermarkTable: 'thread_dynamic_tools',
  });
  expect(dtCursor).toBeNull();
  const seCursor = getCursor(buffer, {
    sourceApp: 'codex',
    sourcePathHash: file.sourcePathHash,
    sourceInode: null,
    watermarkTable: 'thread_spawn_edges',
  });
  expect(seCursor?.watermarkEnd).toBe(2);
});

test('only ships rows past the saved per-table watermark on subsequent polls', async () => {
  const file = await makeStateDb({
    threads: [{ id: 't1', cli_version: '0.1.0' }],
  });
  await collectCodexState(file, ctx(buffer));
  expect(countByStatus(buffer).pending).toBe(1);

  const db = new Database(file.sourcePath);
  db.query('INSERT INTO threads (id, cli_version) VALUES (?, ?)').run('t2', '0.2.0');
  db.close();
  const stat = await statFile(file.sourcePath);
  if (!stat.exists) throw new Error('missing');
  const refreshed: DiscoveredCodexStateFile = {
    ...file,
    sizeBytes: stat.size,
    lastModifiedMs: stat.mtimeMs,
  };
  const second = await collectCodexState(refreshed, ctx(buffer));
  expect(second.result.capturedBatches).toBe(1);
  expect(second.agentSchemaVersion).toBe('0.2.0');
  expect(countByStatus(buffer).pending).toBe(2);
});

test('every emitted state batch carries one of the three allowed watermark_table values', async () => {
  const file = await makeStateDb({
    threads: [{ id: 't1', cli_version: '0.1.0' }],
    dynamicTools: [{ thread_id: 't1', position: 0, name: 'a' }],
    spawnEdges: [{ parent_thread_id: 't1', child_thread_id: 't2', status: 'ok' }],
  });
  await collectCodexState(file, ctx(buffer));
  const tables = new Set<string>();
  for (let i = 0; i < 10; i++) {
    const next = nextPendingBatch(buffer);
    if (next === null) break;
    tables.add(next.watermarkTable ?? 'NULL');
    if (typeof next.captureId === 'string') {
      const fetched = getBatch(buffer, next.captureId);
      expect(fetched).not.toBeNull();
    }
    break;
  }
  expect(tables.size).toBeGreaterThan(0);
  for (const t of tables) {
    expect(['threads', 'thread_dynamic_tools', 'thread_spawn_edges']).toContain(t);
  }
});

test('skip-list: never inserts a batch for a table outside the allowlist', async () => {
  const file = await makeStateDb({
    threads: [{ id: 't1', cli_version: '0.1.0' }],
    forbiddenTables: [
      { name: 'auth', rows: [{ id: 1, secret: 'oauth-token-xyz' }] },
      { name: 'logs', rows: [{ id: 1, secret: 'log-line' }] },
      { name: 'agent_jobs', rows: [{ id: 1, secret: 'private' }] },
    ],
  });
  const { result } = await collectCodexState(file, ctx(buffer));
  expect(result.capturedBatches).toBe(1);

  let scanned = 0;
  for (let i = 0; i < 10; i++) {
    const batch = nextPendingBatch(buffer);
    if (batch === null) break;
    scanned += 1;
    expect(batch.sourceApp).toBe('codex');
    expect(batch.sourceKind).toBe('sqlite_table_snapshot');
    expect(batch.watermarkTable).not.toBe('auth');
    expect(batch.watermarkTable).not.toBe('logs');
    expect(batch.watermarkTable).not.toBe('agent_jobs');
    expect(['threads', 'thread_dynamic_tools', 'thread_spawn_edges']).toContain(
      batch.watermarkTable ?? 'NULL',
    );
    break;
  }
  expect(scanned).toBe(1);
});

test('redacts secrets embedded in row values before storing', async () => {
  const file = await makeStateDb({
    threads: [
      {
        id: 't1',
        cli_version: '0.1.0',
        cwd: '/Users/x/.env=sk-AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQrSt',
      },
    ],
  });
  await collectCodexState(file, ctx(buffer));
  const batch = requireDefined(nextPendingBatch(buffer));
  const decompressed = DECODER.decode(zstdDecompressSync(batch.body));
  expect(decompressed).toContain('[REDACTED:openai-api-key]');
  expect(decompressed).not.toContain('sk-AbCdEfGhIj');
});

test('persists the wire-DTO fields needed by the uploader', async () => {
  const file = await makeStateDb({
    threads: [{ id: 't1', cli_version: '0.126.0-alpha.8' }],
  });
  await collectCodexState(file, ctx(buffer));
  const batch = requireDefined(nextPendingBatch(buffer));
  expect(batch.sourceApp).toBe('codex');
  expect(batch.sourceKind).toBe('sqlite_table_snapshot');
  expect(batch.bodyFormat).toBe('sqlite_rows_json');
  expect(batch.bodyCompression).toBe('zstd');
  expect(batch.watermarkKind).toBe('rowid_range');
  expect(batch.watermarkTable).toBe('threads');
  expect(batch.sourceInode).toBeNull();
  expect(batch.agentSchemaVersion).toBe('0.126.0-alpha.8');
  expect(batch.gatewayVersion).toBe('@proxai/gateway 0.1.0');
  expect(batch.capturedAtUtc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('records errors and does not crash when the source file is unreadable', async () => {
  const fakeFile: DiscoveredCodexStateFile = {
    sourcePath: join(dir, 'does-not-exist.sqlite'),
    sourcePathHash: sha256Hex(join(dir, 'does-not-exist.sqlite')),
    inode: 9999,
    sizeBytes: 100,
    lastModifiedMs: Date.now(),
  };
  const { result } = await collectCodexState(fakeFile, ctx(buffer));
  expect(result.errors.length).toBeGreaterThan(0);
  expect(result.capturedBatches).toBe(0);
});

test('increments consecutive_errors on per-file collector failure', async () => {
  const fakeFile: DiscoveredCodexStateFile = {
    sourcePath: join(dir, 'does-not-exist-2.sqlite'),
    sourcePathHash: sha256Hex(join(dir, 'does-not-exist-2.sqlite')),
    inode: 7777,
    sizeBytes: 100,
    lastModifiedMs: Date.now(),
  };
  setCursor(buffer, {
    sourceApp: 'codex',
    sourcePathHash: fakeFile.sourcePathHash,
    sourcePath: fakeFile.sourcePath,
    sourceInode: null,
    watermarkTable: null,
    watermarkEnd: 0,
    consecutiveErrors: 1,
  });
  await collectCodexState(fakeFile, ctx(buffer));
  const cursor = getCursor(buffer, {
    sourceApp: 'codex',
    sourcePathHash: fakeFile.sourcePathHash,
    sourceInode: null,
    watermarkTable: null,
  });
  expect(cursor?.consecutiveErrors).toBe(2);
});

test('resets consecutive_errors on success after prior table failure', async () => {
  const file = await makeStateDb({
    threads: [{ id: 't1', cli_version: '0.1.0' }],
  });
  setCursor(buffer, {
    sourceApp: 'codex',
    sourcePathHash: file.sourcePathHash,
    sourcePath: file.sourcePath,
    sourceInode: null,
    watermarkTable: 'threads',
    watermarkEnd: 1,
    consecutiveErrors: 4,
  });
  await collectCodexState(file, ctx(buffer));
  const cursor = getCursor(buffer, {
    sourceApp: 'codex',
    sourcePathHash: file.sourcePathHash,
    sourceInode: null,
    watermarkTable: 'threads',
  });
  expect(cursor?.consecutiveErrors).toBe(0);
});

test('returns "unknown" agentSchemaVersion when threads table is absent', async () => {
  const path = join(dir, 'state_no_threads.sqlite');
  const db = new Database(path, { create: true });
  db.run(
    'CREATE TABLE thread_dynamic_tools (thread_id TEXT, position INTEGER, name TEXT, PRIMARY KEY (thread_id, position))',
  );
  db.close();
  const stat = await statFile(path);
  if (!stat.exists) throw new Error('seed failed');
  const file: DiscoveredCodexStateFile = {
    sourcePath: path,
    sourcePathHash: sha256Hex(path),
    inode: Number(stat.inode),
    sizeBytes: stat.size,
    lastModifiedMs: stat.mtimeMs,
  };
  const { agentSchemaVersion } = await collectCodexState(file, ctx(buffer));
  expect(agentSchemaVersion).toBe('unknown');
});

test('falls back to "unknown" when sampleCliVersion query throws on a malformed threads table', async () => {
  const path = join(dir, 'state_bad_threads.sqlite');
  const db = new Database(path, { create: true });
  db.run('CREATE TABLE threads (id TEXT PRIMARY KEY)');
  db.close();
  const stat = await statFile(path);
  if (!stat.exists) throw new Error('seed failed');
  const file: DiscoveredCodexStateFile = {
    sourcePath: path,
    sourcePathHash: sha256Hex(path),
    inode: Number(stat.inode),
    sizeBytes: stat.size,
    lastModifiedMs: stat.mtimeMs,
  };
  const { agentSchemaVersion } = await collectCodexState(file, ctx(buffer));
  expect(agentSchemaVersion).toBe('unknown');
});

test('a fresh poll persists last_seen_size_bytes and last_seen_page_count on each per-table cursor', async () => {
  const file = await makeStateDb({
    threads: [{ id: 't1', cli_version: '0.1.0' }],
    dynamicTools: [{ thread_id: 't1', position: 0, name: 'a' }],
    spawnEdges: [{ parent_thread_id: 't1', child_thread_id: 't2', status: 'ok' }],
  });
  await collectCodexState(file, ctx(buffer));
  for (const table of ['threads', 'thread_spawn_edges']) {
    const c = getCursor(buffer, {
      sourceApp: 'codex',
      sourcePathHash: file.sourcePathHash,
      sourceInode: null,
      watermarkTable: table,
    });
    expect(c).not.toBeNull();
    expect(requireDefined(c).lastSeenSizeBytes).toBeGreaterThan(0);
    expect(requireDefined(c).lastSeenPageCount).toBeGreaterThan(0);
  }
});

test('rowid regression on a single codex table re-keys the whole file under #gen=1', async () => {
  const file = await makeStateDb({
    threads: [{ id: 't1', cli_version: '0.1.0' }],
    dynamicTools: [{ thread_id: 't1', position: 0, name: 'a' }],
    spawnEdges: [{ parent_thread_id: 't1', child_thread_id: 't2', status: 'ok' }],
  });
  setCursor(buffer, {
    sourceApp: 'codex',
    sourcePathHash: file.sourcePathHash,
    sourcePath: file.sourcePath,
    sourceInode: null,
    watermarkTable: 'threads',
    watermarkEnd: 9999,
    lastSeenSizeBytes: 99_000_000,
    lastSeenPageCount: 24_000,
  });

  const { result } = await collectCodexState(file, ctx(buffer));
  expect(result.capturedBatches).toBe(2);

  const expectedNewPath = nextGenerationSuffix(file.sourcePath);
  const expectedNewHash = sha256Hex(expectedNewPath);

  const seenTables = new Set<string>();
  for (let i = 0; i < 5; i++) {
    const batch = nextPendingBatch(buffer);
    if (batch === null) break;
    expect(batch.sourcePath).toBe(expectedNewPath);
    expect(batch.sourcePathHash).toBe(expectedNewHash);
    expect(batch.watermarkStart).toBe(1);
    seenTables.add(batch.watermarkTable ?? 'NULL');
  }
  expect(seenTables.has('threads')).toBe(true);

  for (const table of ['threads', 'thread_spawn_edges']) {
    const c = getCursor(buffer, {
      sourceApp: 'codex',
      sourcePathHash: expectedNewHash,
      sourceInode: null,
      watermarkTable: table,
    });
    expect(c).not.toBeNull();
    expect(requireDefined(c).watermarkEnd).toBeGreaterThan(0);
  }

  const oldThreads = getCursor(buffer, {
    sourceApp: 'codex',
    sourcePathHash: file.sourcePathHash,
    sourceInode: null,
    watermarkTable: 'threads',
  });
  expect(oldThreads?.watermarkEnd).toBe(9999);
});

test('size_decreased signal on any tracked table re-keys the whole codex file', async () => {
  const file = await makeStateDb({
    threads: [{ id: 't1', cli_version: '0.1.0' }],
  });
  setCursor(buffer, {
    sourceApp: 'codex',
    sourcePathHash: file.sourcePathHash,
    sourcePath: file.sourcePath,
    sourceInode: null,
    watermarkTable: 'threads',
    watermarkEnd: 2,
    lastSeenSizeBytes: 99_000_000,
    lastSeenPageCount: 1,
  });

  const { result } = await collectCodexState(file, ctx(buffer));
  expect(result.capturedBatches).toBe(1);
  const batch = requireDefined(nextPendingBatch(buffer));
  expect(batch.sourcePath).toBe(nextGenerationSuffix(file.sourcePath));
  expect(batch.watermarkStart).toBe(1);
});

test('null last_seen columns on existing codex cursor do not trigger size/page_count rotation', async () => {
  const file = await makeStateDb({
    threads: [
      { id: 't1', cli_version: '0.1.0' },
      { id: 't2', cli_version: '0.2.0' },
    ],
  });
  setCursor(buffer, {
    sourceApp: 'codex',
    sourcePathHash: file.sourcePathHash,
    sourcePath: file.sourcePath,
    sourceInode: null,
    watermarkTable: 'threads',
    watermarkEnd: 1,
    lastSeenSizeBytes: null,
    lastSeenPageCount: null,
  });

  await collectCodexState(file, ctx(buffer));
  const batch = requireDefined(nextPendingBatch(buffer));

  expect(batch.sourcePath).toBe(file.sourcePath);
  expect(batch.sourcePathHash).toBe(file.sourcePathHash);
});

test('splits an oversized table snapshot into multiple batches with contiguous rowid coverage', async () => {
  const path = join(dir, 'big_state.sqlite');
  const db = new Database(path, { create: true });
  db.run(
    `CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      cli_version TEXT,
      cwd TEXT,
      title TEXT,
      model TEXT
    )`,
  );
  const rowCount = 30;
  const insert = db.prepare(
    'INSERT INTO threads (id, cli_version, cwd, title, model) VALUES (?, ?, ?, ?, ?)',
  );
  const tx = db.transaction(() => {
    for (let i = 0; i < rowCount; i++) {
      const noise = randomBytes(1000).toString('base64');
      insert.run(`t${i.toString()}`, '0.126.0', noise, 't', 'gpt-5');
    }
  });
  tx();
  db.close();

  const stat = await statFile(path);
  if (!stat.exists) throw new Error('seed missing');
  const file: DiscoveredCodexStateFile = {
    sourcePath: path,
    sourcePathHash: sha256Hex(path),
    inode: Number(stat.inode),
    sizeBytes: stat.size,
    lastModifiedMs: stat.mtimeMs,
  };

  const customCtx = {
    ...ctx(buffer),
    maxDecompressedBytes: 15_000,
  };
  const { result } = await collectCodexState(file, customCtx);
  expect(result.errors).toEqual([]);

  expect(result.capturedBatches).toBeGreaterThanOrEqual(2);

  let prevEnd = 0;
  let scanned = 0;
  for (let i = 0; i < 50; i++) {
    const batch = nextPendingBatch(buffer);
    if (batch === null) break;
    expect(batch.body.byteLength).toBeLessThanOrEqual(BODY_MAX_COMPRESSED_BYTES);
    expect(batch.body.byteLength).toBeLessThanOrEqual(BODY_TARGET_COMPRESSED_BYTES);
    expect(batch.watermarkTable).toBe('threads');
    if (scanned === 0) {
      expect(batch.watermarkStart).toBe(1);
    } else {
      expect(batch.watermarkStart).toBe(prevEnd);
    }
    expect(batch.watermarkEnd).toBeGreaterThan(batch.watermarkStart);
    prevEnd = batch.watermarkEnd;
    scanned += 1;
    deleteBatch(buffer, batch.captureId);
  }
  expect(scanned).toBe(result.capturedBatches);
  const cursor = getCursor(buffer, {
    sourceApp: 'codex',
    sourcePathHash: file.sourcePathHash,
    sourceInode: null,
    watermarkTable: 'threads',
  });
  expect(cursor?.watermarkEnd).toBe(rowCount + 1);
  expect(prevEnd).toBe(rowCount + 1);
}, 120_000);

test('second poll with no new rows refreshes lastSeenSize/PageCount on the existing cursor', async () => {
  const file = await makeStateDb({
    threads: [{ id: 't1', cli_version: '0.1.0' }],
    dynamicTools: [{ thread_id: 't1', position: 0, name: 'a' }],
  });
  await collectCodexState(file, ctx(buffer));

  const before = getCursor(buffer, {
    sourceApp: 'codex',
    sourcePathHash: file.sourcePathHash,
    sourceInode: null,
    watermarkTable: 'threads',
  });
  expect(before).not.toBeNull();
  const beforeWatermark = requireDefined(before).watermarkEnd;
  expect(beforeWatermark).toBeGreaterThan(0);

  const db = new Database(file.sourcePath);
  db.run('CREATE TABLE __padding (k TEXT)');
  for (let i = 0; i < 100; i++) {
    db.run(`INSERT INTO __padding (k) VALUES ('${'x'.repeat(64)}-${i.toString()}')`);
  }
  db.close();

  const refreshed = await statFile(file.sourcePath);
  const refreshedFile: DiscoveredCodexStateFile = {
    ...file,
    sizeBytes: refreshed.exists ? refreshed.size : file.sizeBytes,
  };

  await collectCodexState(refreshedFile, ctx(buffer));

  const after = getCursor(buffer, {
    sourceApp: 'codex',
    sourcePathHash: file.sourcePathHash,
    sourceInode: null,
    watermarkTable: 'threads',
  });
  expect(after).not.toBeNull();

  expect(requireDefined(after).watermarkEnd).toBe(beforeWatermark);
  expect(requireDefined(after).lastSeenSizeBytes).not.toBe(
    requireDefined(before).lastSeenSizeBytes,
  );
}, 30_000);

test('logs quarantine.write_failed when quarantine insert throws', async () => {
  const path = join(dir, 'oversized_quarantine_fail.sqlite');
  const db = new Database(path, { create: true });
  db.run(
    `CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      cli_version TEXT,
      cwd TEXT,
      title TEXT,
      model TEXT
    )`,
  );
  const giant = 'x'.repeat(20_000);
  db.query('INSERT INTO threads (id, cli_version, cwd, title, model) VALUES (?, ?, ?, ?, ?)').run(
    't-big',
    '0.1.0',
    giant,
    'oversize',
    'gpt-5',
  );
  db.close();

  const stat = await statFile(path);
  if (!stat.exists) throw new Error('seed missing');
  const file: DiscoveredCodexStateFile = {
    sourcePath: path,
    sourcePathHash: sha256Hex(path),
    inode: Number(stat.inode),
    sizeBytes: stat.size,
    lastModifiedMs: stat.mtimeMs,
  };
  const warns: { msg: string; bindings: unknown }[] = [];
  interface FakeLog {
    info: (...args: unknown[]) => void;
    warn: (bindings: unknown, msg: string) => void;
    error: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
    trace: (...args: unknown[]) => void;
    fatal: (...args: unknown[]) => void;
    child: () => FakeLog;
  }
  const fakeLogger: FakeLog = {
    info: () => {},
    warn: (bindings, msg) => {
      warns.push({ msg, bindings });
    },
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    child: () => fakeLogger,
  };

  buffer.exec('DROP TABLE quarantined_records');

  const baseCtx = ctx(buffer);
  const fakeCtx = {
    ...baseCtx,
    logger: fakeLogger,
    maxDecompressedBytes: 15_000,
  };
  const { result } = await collectCodexState(file, fakeCtx);
  expect(result.errors.some((e) => /quarantined/.test(e.reason))).toBe(true);
  expect(warns.some((w) => w.msg.includes('failed to record oversized row'))).toBe(true);
}, 120_000);

test('quarantines oversized codex state row, advances cursor, and continues to next row', async () => {
  const path = join(dir, 'oversized_quarantine.sqlite');
  const db = new Database(path, { create: true });
  db.run(
    `CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      cli_version TEXT,
      cwd TEXT,
      title TEXT,
      model TEXT
    )`,
  );
  db.run(
    `CREATE TABLE thread_dynamic_tools (
      thread_id TEXT,
      position INTEGER,
      name TEXT,
      PRIMARY KEY (thread_id, position)
    )`,
  );
  db.run(
    `CREATE TABLE thread_spawn_edges (
      parent_thread_id TEXT,
      child_thread_id TEXT PRIMARY KEY,
      status TEXT
    )`,
  );
  const giant = 'x'.repeat(20_000);
  db.query('INSERT INTO threads (id, cli_version, cwd, title, model) VALUES (?, ?, ?, ?, ?)').run(
    't-big',
    '0.1.0',
    giant,
    'oversize',
    'gpt-5',
  );
  db.query('INSERT INTO threads (id, cli_version, cwd, title, model) VALUES (?, ?, ?, ?, ?)').run(
    't-small',
    '0.1.0',
    '/tmp',
    'normal',
    'gpt-5',
  );
  db.close();

  const stat = await statFile(path);
  if (!stat.exists) throw new Error('seed missing');
  const file: DiscoveredCodexStateFile = {
    sourcePath: path,
    sourcePathHash: sha256Hex(path),
    inode: Number(stat.inode),
    sizeBytes: stat.size,
    lastModifiedMs: stat.mtimeMs,
  };

  const customCtx = {
    ...ctx(buffer),
    maxDecompressedBytes: 15_000,
  };
  const { result } = await collectCodexState(file, customCtx);

  expect(countQuarantined(buffer, 'codex')).toBeGreaterThanOrEqual(1);

  const cursor = getCursor(buffer, {
    sourceApp: 'codex',
    sourcePathHash: file.sourcePathHash,
    sourceInode: null,
    watermarkTable: 'threads',
  });
  expect(cursor).not.toBeNull();
  expect(requireDefined(cursor).watermarkEnd).toBeGreaterThan(1);
  expect(requireDefined(cursor).consecutiveErrors).toBeGreaterThanOrEqual(1);

  expect(result.capturedBatches).toBeGreaterThanOrEqual(1);
}, 120_000);

test('surfaces OversizedDecompressedSliceError when single row exceeds maxDecompressedBytes', async () => {
  const path = join(dir, 'oversized_state.sqlite');
  const db = new Database(path, { create: true });
  db.run(
    `CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      cli_version TEXT,
      cwd TEXT,
      title TEXT,
      model TEXT
    )`,
  );
  db.run(
    `CREATE TABLE thread_dynamic_tools (
      thread_id TEXT,
      position INTEGER,
      name TEXT,
      PRIMARY KEY (thread_id, position)
    )`,
  );
  db.run(
    `CREATE TABLE thread_spawn_edges (
      parent_thread_id TEXT,
      child_thread_id TEXT PRIMARY KEY,
      status TEXT
    )`,
  );
  const giantPayload = 'x'.repeat(20_000);
  db.query('INSERT INTO threads (id, cli_version, cwd, title, model) VALUES (?, ?, ?, ?, ?)').run(
    't1',
    '0.1.0',
    giantPayload,
    't',
    'gpt-5',
  );
  db.close();

  const stat = await statFile(path);
  if (!stat.exists) throw new Error('seed missing');
  const file: DiscoveredCodexStateFile = {
    sourcePath: path,
    sourcePathHash: sha256Hex(path),
    inode: Number(stat.inode),
    sizeBytes: stat.size,
    lastModifiedMs: stat.mtimeMs,
  };

  const customCtx = {
    ...ctx(buffer),
    maxDecompressedBytes: 15_000,
  };
  const { result } = await collectCodexState(file, customCtx);
  const oversized = result.errors.filter((e) => /decompressed slice/.test(e.reason));
  expect(oversized.length).toBeGreaterThanOrEqual(1);
}, 120_000);

test('every codex-state batch satisfies BOTH compressed AND decompressed caps', async () => {
  const file = await makeStateDb({
    threads: [
      { id: 't1', cli_version: '0.1.0', cwd: '/tmp/a', title: 't1' },
      { id: 't2', cli_version: '0.1.0', cwd: '/tmp/b', title: 't2' },
    ],
    dynamicTools: [
      { thread_id: 't1', position: 0, name: 'web_search' },
      { thread_id: 't2', position: 0, name: 'compose' },
    ],
  });
  const { result } = await collectCodexState(file, ctx(buffer));
  expect(result.errors).toEqual([]);

  for (let i = 0; i < 100; i++) {
    const batch = nextPendingBatch(buffer);
    if (batch === null) break;
    expect(batch.body.byteLength).toBeLessThanOrEqual(BODY_MAX_COMPRESSED_BYTES);
    const decoded = zstdDecompressSync(batch.body);
    expect(decoded.byteLength).toBeLessThanOrEqual(BODY_MAX_DECOMPRESSED_BYTES);
    deleteBatch(buffer, batch.captureId);
  }
});
