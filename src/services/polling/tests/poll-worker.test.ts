import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { rmRecursive } from 'core/io/fs';
import { mkdir, mkdtemp, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkerInput, WorkerOutput } from 'services/polling/poll-worker.types.ts';

let postMessageCalled = false;
let postedMessage: WorkerOutput | null = null;

const mockSelf = {
  onmessage: null as ((event: MessageEvent<WorkerInput>) => void) | null,
  postMessage: (message: WorkerOutput) => {
    postMessageCalled = true;
    postedMessage = message;
  },
};

(globalThis as { self?: unknown }).self = mockSelf;

const importPath = 'services/polling/poll-worker.ts';
const { handleCapture, handleInspect, dispatchWorkerMessage, registerWorkerHandler } = await import(
  importPath
);

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-poll-worker-tests-'));
});

afterEach(async () => {
  await rmRecursive(dir);
});

test('registerWorkerHandler wires dispatchWorkerMessage onto a worker-scope self', () => {
  const original = (globalThis as { self?: unknown }).self;
  try {
    mockSelf.onmessage = null;
    (globalThis as { self?: unknown }).self = mockSelf;
    registerWorkerHandler();
    expect(mockSelf.onmessage).toBe(dispatchWorkerMessage);

    const bare: { onmessage: unknown; postMessage?: unknown } = { onmessage: 'untouched' };
    (globalThis as { self?: unknown }).self = bare;
    registerWorkerHandler();
    expect(bare.onmessage).toBe('untouched');
  } finally {
    (globalThis as { self?: unknown }).self = original;
  }
});

// Helper to create a fake cursor SQLite DB
async function seedCursorDb(
  path: string,
  rows: { key: string; value: string | null }[],
): Promise<void> {
  const db = new Database(path, { create: true });
  db.run('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)');
  const stmt = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)');
  for (const r of rows) {
    stmt.run(r.key, r.value);
  }
  db.close();
}

// Helper to create a fake codex SQLite DB
async function seedCodexDb(path: string, threads: string[], spawnEdges: string[]): Promise<void> {
  const db = new Database(path, { create: true });
  db.run('CREATE TABLE threads (id TEXT PRIMARY KEY)');
  db.run('CREATE TABLE thread_spawn_edges (id TEXT PRIMARY KEY)');

  const insertThread = db.prepare('INSERT INTO threads (id) VALUES (?)');
  for (const t of threads) {
    insertThread.run(t);
  }

  const insertEdge = db.prepare('INSERT INTO thread_spawn_edges (id) VALUES (?)');
  for (const e of spawnEdges) {
    insertEdge.run(e);
  }
  db.close();
}

test('createCompressedSizer: flushes on large inputs and finishes correctly', async () => {
  const projectDir = join(dir, 'proj');
  await mkdir(projectDir, { recursive: true });
  const logPath = join(projectDir, 'session.jsonl');
  const largeRecord =
    '{"type":"user","message":{"role":"user","content":"' + 'a'.repeat(4.5 * 1024 * 1024) + '"}}';
  await writeFile(logPath, largeRecord + '\n');

  const result = await handleInspect('claude-code', {
    baseDir: dir,
    captureSubAgents: false,
    priorCursors: [],
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
  });

  expect(result.filesProcessed).toBe(1);
  expect(result.telemetryRecordCount).toBe(1);
  expect(result.telemetryCompressedBytes).toBeGreaterThan(0);
});

test('isPromptRecord & isCursorPromptRow: covers all matching cases in handleInspect', async () => {
  const sessionDir = join(dir, 'org', 'proj', 'local_1');
  await mkdir(sessionDir, { recursive: true });
  const logPath = join(sessionDir, 'audit.jsonl');

  // Include different timestamps to cover date comparison branches (oldest vs newest)
  // Also include malformed JSON lines to cover JSON parsing catch block (line 155)
  const lines = [
    '{"type":"user","message":{"role":"user","content":"hello"},"timestamp":"2026-05-01T00:00:00Z"}',
    '{"type":"user","message":{"role":"user","content":"older"},"timestamp":"2026-04-01T00:00:00Z"}',
    '{"type":"user","message":{"role":"user","content":"newer"},"timestamp":"2026-06-01T00:00:00Z"}',
    '{"type":"assistant","message":{"role":"assistant","content":"reply"},"timestamp":"2026-05-02T00:00:00Z"}',
    '{"type":"invalid-no-timestamp"}',
    '{"invalid-json":',
  ];
  await writeFile(logPath, lines.join('\n') + '\n');

  const result = await handleInspect('claude-desktop', {
    baseDir: dir,
    priorCursors: [],
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
  });

  expect(result.filesProcessed).toBe(1);
  expect(result.promptCount).toBe(3);
  expect(result.oldestDate).toBe('2026-04-01T00:00:00.000Z');
  expect(result.newestDate).toBe('2026-06-01T00:00:00.000Z');
});

test('handleInspect: cursor database with various rows and keys', async () => {
  const globalStorageDir = join(dir, 'globalStorage');
  await mkdir(globalStorageDir, { recursive: true });
  const dbPath = join(globalStorageDir, 'state.vscdb');

  const rows = [
    { key: 'composerData:123', value: '{"text":"hello"}' },
    { key: 'composerData:null-val', value: null },
    { key: 'composerData:invalid-json', value: 'invalid-json' },
    { key: 'composerData:primitive-json', value: '123' },
    { key: 'bubbleId:1', value: '{"type":1,"text":"user message"}' },
    { key: 'bubbleId:2', value: '{"type":2,"text":"ignored assistant message"}' },
    { key: 'bubbleId:3', value: '{"type":1,"text":""}' },
    { key: 'bubbleId:4', value: '{"type":1}' },
    { key: 'bubbleId:5', value: 'invalid-json' },
    { key: 'bubbleId:6', value: 'null' },
    { key: 'bubbleId:null-val', value: null },
    { key: 'agentKv:blob:1', value: '{"role":"user"}' },
    { key: 'agentKv:blob:2', value: '{"role":"assistant"}' },
  ];
  await seedCursorDb(dbPath, rows);

  const result = await handleInspect('cursor', {
    baseDir: dir,
    priorCursors: [],
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
  });

  expect(result.filesProcessed).toBe(1);
  expect(result.telemetryRecordCount).toBe(8);
  expect(result.promptCount).toBe(2);
});

test('handleInspect: codex with sqlite state and rollout jsonl files', async () => {
  // Seed the state SQLite db state_*.sqlite
  const stateDbPath = join(dir, 'state_1.sqlite');
  await seedCodexDb(stateDbPath, ['thread-1'], ['edge-1']);

  // Seed a rollout session file sessions/*/*/*/rollout-*.jsonl
  const rolloutDir = join(dir, 'sessions', '2026', '05', '21');
  await mkdir(rolloutDir, { recursive: true });
  const logPath = join(rolloutDir, 'rollout-1.jsonl');
  const lines = [
    JSON.stringify({
      type: 'session_meta',
      payload: { cli_version: '0.1.0' },
    }),
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_started' },
    }),
    JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: 'hello' },
    }),
    JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: 'hi' },
    }),
  ];
  await writeFile(logPath, lines.join('\n') + '\n');

  const result = await handleInspect('codex', {
    baseDir: dir,
    captureSubAgents: true,
    priorCursors: [],
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
  });

  expect(result.filesProcessed).toBe(2);
  expect(result.telemetryRecordCount).toBe(6);
  expect(result.promptCount).toBe(1);
});

test('handleInspect: handles file inspect errors and codex errors gracefully', async () => {
  // chmod 0o000 only blocks reads on POSIX; Windows ignores the bits, so the
  // file-read-error scenarios (1, 4, 5) can't be reproduced there.
  const posix = process.platform !== 'win32';

  // 1. Claude Code error: an unreadable session file (POSIX only)
  if (posix) {
    const projectDir = join(dir, 'proj-err');
    await mkdir(projectDir, { recursive: true });
    const errLogPath = join(projectDir, 'session.jsonl');
    await writeFile(errLogPath, 'invalid-log-data');
    await chmod(errLogPath, 0o000);

    const result = await handleInspect('claude-code', {
      baseDir: dir,
      captureSubAgents: false,
      priorCursors: [],
      gatewayVersion: 'gw-0.1',
      maxDecompressedBytes: 9 * 1024 * 1024,
    });
    expect(result.errors.length).toBe(1);
  }

  // 2. Codex SQLite state database error: an invalid SQLite file (cross-platform)
  const errStatePath = join(dir, 'state_1.sqlite');
  await writeFile(errStatePath, 'invalid-sqlite-db-data');

  const resultCodex = await handleInspect('codex', {
    baseDir: dir,
    captureSubAgents: true,
    priorCursors: [],
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
  });
  expect(resultCodex.errors.length).toBe(1);

  // 3. Cursor SQLite read error: an invalid state.vscdb (cross-platform)
  const cursorGlobalDir = join(dir, 'globalStorage');
  await mkdir(cursorGlobalDir, { recursive: true });
  const errCursorPath = join(cursorGlobalDir, 'state.vscdb');
  await writeFile(errCursorPath, 'invalid-sqlite-db-data');

  const resultCursor = await handleInspect('cursor', {
    baseDir: dir,
    priorCursors: [],
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
  });
  expect(resultCursor.errors.length).toBe(1);

  // Clean up cursor invalid file before next tests so they don't interfere
  await rmRecursive(cursorGlobalDir);

  // 4. Codex rollout session file inspect error: an unreadable rollout (POSIX only)
  if (posix) {
    const codexDir = join(dir, 'codex-proj-err');
    const rolloutDir = join(codexDir, 'sessions', '2026', '05', '21');
    await mkdir(rolloutDir, { recursive: true });
    const errRolloutPath = join(rolloutDir, 'rollout-1.jsonl');
    await writeFile(errRolloutPath, 'invalid-log-data');
    await chmod(errRolloutPath, 0o000);

    const resultCodexRollout = await handleInspect('codex', {
      baseDir: codexDir,
      captureSubAgents: true,
      priorCursors: [],
      gatewayVersion: 'gw-0.1',
      maxDecompressedBytes: 9 * 1024 * 1024,
    });
    expect(resultCodexRollout.errors.length).toBe(1);
  }
});

test('handleInspect: codex rollout discovery error is recorded as codex rollout', async () => {
  const result = await handleInspect('codex', {
    baseDir: join(dir, 'codex\0home'),
    captureSubAgents: true,
    priorCursors: [],
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
  });

  const errors: string[] = result.errors;
  expect(errors.some((e) => e.startsWith('codex rollout:'))).toBe(true);
});

test('handleCapture: supports options.priorCursors, custom baseDir, and throws on unknown poller', async () => {
  const outcome = await handleCapture('claude-code', {
    baseDir: join(dir, 'missing-claude'),
    priorCursors: [
      {
        sourcePathHash: 'a'.repeat(64),
        sourcePath: '/tmp/nonexistent.jsonl',
        sourceInode: 1,
        watermarkTable: '',
        watermarkEnd: 100,
        lastSeenSizeBytes: 500,
        lastSeenPageCount: 1,
        consecutiveErrors: 0,
      },
    ],
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
  });

  expect(outcome.filesProcessed).toBe(0);
  expect(outcome.batches.length).toBe(0);
  expect(outcome.cursors.length).toBe(1);

  expect(
    handleCapture('unknown-poller', {
      priorCursors: [],
      gatewayVersion: 'gw-0.1',
      maxDecompressedBytes: 9 * 1024 * 1024,
    }),
  ).rejects.toThrow('Unknown source poller: unknown-poller');
});

test('handleCapture: threads desktopCliSessionIds and tags the batch source_platform', async () => {
  const projectDir = join(dir, 'proj');
  await mkdir(projectDir, { recursive: true });
  const logPath = join(projectDir, 'sess-desktop.jsonl');
  await writeFile(logPath, '{"type":"user","message":{"content":"hi"}}\n');

  const outcome = await handleCapture('claude-code', {
    baseDir: dir,
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
    captureSubAgents: false,
    desktopCliSessionIds: new Set(['sess-desktop']),
  });

  expect(outcome.batches.length).toBe(1);
  expect(outcome.batches[0]?.sourcePlatform).toBe('claude-code-desktop');
});

test('handleCapture: claude-code batch is codex-cli-free and defaults source_platform to cli', async () => {
  const projectDir = join(dir, 'proj');
  await mkdir(projectDir, { recursive: true });
  const logPath = join(projectDir, 'sess-cli.jsonl');
  await writeFile(logPath, '{"type":"user","message":{"content":"hi"}}\n');

  const outcome = await handleCapture('claude-code', {
    baseDir: dir,
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
    captureSubAgents: false,
  });

  expect(outcome.batches.length).toBe(1);
  expect(outcome.batches[0]?.sourcePlatform).toBe('claude-code-cli');
});

test('handleCapture: runs capture for cursor successfully, maps quarantine', async () => {
  // Mock Database.prototype.query specifically to return quarantine rows
  const originalQuery = Database.prototype.query;
  let injectQuarantine = false;

  Database.prototype.query = function (this: Database, sql: string) {
    if (injectQuarantine && sql === 'SELECT * FROM quarantined_records') {
      return {
        all: () => [
          {
            source_app: 'cursor',
            source_path: '/tmp/c.db',
            source_path_hash: 'b'.repeat(64),
            source_inode: 2,
            watermark_table: 'workspace_tabs',
            watermark_position: 15,
            row_pk: 'pk1',
            redacted_size_bytes: 1000,
            reason: 'too big',
            quarantined_at_utc: '2026-05-08T00:00:00Z',
            gateway_version: 'gw-0.1',
          },
        ],
      } as unknown as ReturnType<Database['query']>;
    }
    return originalQuery.call(this, sql);
  } as unknown as typeof Database.prototype.query;

  try {
    // Test cursor poller with state.vscdb under globalStorage
    const globalStorageDir = join(dir, 'globalStorage');
    await mkdir(globalStorageDir, { recursive: true });
    const dbPath = join(globalStorageDir, 'state.vscdb');
    await seedCursorDb(dbPath, [{ key: 'composerData:1', value: '{"text":"val"}' }]);

    injectQuarantine = true;
    const cursorOutcome = await handleCapture('cursor', {
      baseDir: dir,
      priorCursors: [],
      gatewayVersion: 'gw-0.1',
      maxDecompressedBytes: 9 * 1024 * 1024,
    });
    expect(cursorOutcome.filesProcessed).toBe(1);
    expect(cursorOutcome.quarantine.length).toBe(1);
    expect(cursorOutcome.quarantine[0]?.rowPk).toBe('pk1');

    injectQuarantine = false;
  } finally {
    Database.prototype.query = originalQuery;
  }
});

test('handleCapture: runs capture for codex successfully', async () => {
  const stateDbPath = join(dir, 'state_1.sqlite');
  await seedCodexDb(stateDbPath, ['t1'], ['e1']);

  const codexOutcome = await handleCapture('codex', {
    baseDir: dir,
    priorCursors: [],
    gatewayVersion: 'gw-0.1',
    maxDecompressedBytes: 9 * 1024 * 1024,
  });
  expect(codexOutcome.filesProcessed).toBe(1);
});
test('Web Worker Listener: handles inspect, capture, unknown task, and capture errors', async () => {
  // Point the global `self` at THIS file's mock (another test file may have set
  // it last), then drive the routing directly — order-independent, no reliance
  // on which file's mock won the shared module evaluation.
  (globalThis as { self?: unknown }).self = mockSelf;
  const onmessage = dispatchWorkerMessage;

  // 1. Test inspect task
  postMessageCalled = false;
  postedMessage = null;
  await onmessage({
    data: {
      task: 'inspect',
      sourceName: 'claude-code',
      options: {
        baseDir: join(dir, 'missing-inspect'),
        priorCursors: [],
        gatewayVersion: 'gw-0.1',
        maxDecompressedBytes: 9 * 1024 * 1024,
      },
    },
  } as unknown as MessageEvent<WorkerInput>);

  expect(postMessageCalled).toBe(true);
  const msg1 = postedMessage as WorkerOutput | null;
  if (!msg1) throw new Error('postedMessage is null');
  expect(msg1.success).toBe(true);
  expect(msg1.inspectResult).toBeDefined();

  // 2. Test capture task
  postMessageCalled = false;
  postedMessage = null;
  await onmessage({
    data: {
      task: 'capture',
      sourceName: 'claude-code',
      options: {
        baseDir: join(dir, 'missing-capture'),
        priorCursors: [],
        gatewayVersion: 'gw-0.1',
        maxDecompressedBytes: 9 * 1024 * 1024,
      },
    },
  } as unknown as MessageEvent<WorkerInput>);

  expect(postMessageCalled).toBe(true);
  const msg2 = postedMessage as WorkerOutput | null;
  if (!msg2) throw new Error('postedMessage is null');
  expect(msg2.success).toBe(true);
  expect(msg2.captureResult).toBeDefined();

  // 3. Test unknown task
  postMessageCalled = false;
  postedMessage = null;
  await onmessage({
    data: {
      task: 'unknown-task' as unknown as WorkerInput['task'],
      sourceName: 'claude-code',
      options: {
        priorCursors: [],
        gatewayVersion: 'gw-0.1',
        maxDecompressedBytes: 9 * 1024 * 1024,
      },
    },
  } as unknown as MessageEvent<WorkerInput>);

  expect(postMessageCalled).toBe(true);
  const msg3 = postedMessage as WorkerOutput | null;
  if (!msg3) throw new Error('postedMessage is null');
  expect(msg3.success).toBe(false);
  expect(msg3.error).toContain('Unknown task');

  // 4. Test error handling in inspect task (throws when options is null)
  postMessageCalled = false;
  postedMessage = null;
  await onmessage({
    data: {
      task: 'inspect',
      sourceName: 'claude-code',
      options: null as unknown as WorkerInput['options'],
    },
  } as unknown as MessageEvent<WorkerInput>);

  expect(postMessageCalled).toBe(true);
  const msg4 = postedMessage as WorkerOutput | null;
  if (!msg4) throw new Error('postedMessage is null');
  expect(msg4.success).toBe(false);
  expect(msg4.error).toBeDefined();
});
