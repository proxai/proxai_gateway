import { afterEach, beforeEach, expect, test } from 'bun:test';

import type { Database } from 'bun:sqlite';
import { rmRecursive } from 'core/io/fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { asMessageEvent, asWorkerCtor, generateUuidV7, zstdCompressSync } from 'core/utils';
import {
  getDaemonState,
  getMetadata,
  insertBatch,
  METADATA_KEYS,
  openInMemoryBufferDb,
  setMetadata,
} from 'services/buffer';
import type { NewBatch } from 'services/buffer';
import {
  isBufferFull,
  runCaptureCycle,
  writeAuthFailedSentinel,
  writeBufferFullSentinel,
} from 'services/polling';
import type { CaptureCycleContext, RegisteredSource } from 'services/polling';
import type { WorkerInput, WorkerOutput } from 'services/polling/poll-worker.types.ts';
import { __deps } from 'services/polling/capture-cycle.ts';

const origHandleCapture = __deps.handleCapture;
const origValidSourceApps = __deps.VALID_SOURCE_APPS;
const origIsCompiledBinary = __deps.isCompiledBinary;

type WorkerMessageHandler = ((event: MessageEvent<WorkerOutput>) => void) | null;
type WorkerErrorHandler = ((event: ErrorEvent) => void) | null;

// SourcePoller stub for tests that exercise the in-worker code path — the
// captured `poll` callback is never actually invoked (the worker mock takes
// over) but the type still has to match SourcePoller's return contract.
const stubPoll = async () => ({
  filesProcessed: 0,
  capturedBatches: 0,
  capturedBytes: 0,
  errors: [],
});

let dir: string;
let buffer: Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-capture-cycle-'));
  buffer = openInMemoryBufferDb();
});

afterEach(async () => {
  buffer.close();
  __deps.handleCapture = origHandleCapture;
  __deps.VALID_SOURCE_APPS = origValidSourceApps;
  __deps.isCompiledBinary = origIsCompiledBinary;
  await rmRecursive(dir);
});

function makeContext(
  sources: RegisteredSource[],
  overrides: Partial<CaptureCycleContext> = {},
): CaptureCycleContext {
  const base: CaptureCycleContext = {
    buffer,
    gatewayVersion: 'gw-0.1',
    sources,
    authFailedSentinelPath: join(dir, 'AUTH_FAILED'),
    bufferFullSentinelPath: join(dir, 'BUFFER_FULL'),
    bufferPolicy: {
      receiptRetentionDays: 30,
      failedRetentionDays: 30,
      softPauseBytes: 700 * 1024 * 1024,
      softResumeBytes: 600 * 1024 * 1024,
    },
    capturePolicy: { maxDecompressedBytes: 9 * 1024 * 1024 },
  };
  return { ...base, ...overrides };
}

function noopSource(name: string): RegisteredSource {
  return {
    name,
    poll: async () => ({
      filesProcessed: 0,
      capturedBatches: 0,
      capturedBytes: 0,
      errors: [],
    }),
  };
}

function bigBatch(byteLen: number): NewBatch {
  const buf = new Uint8Array(byteLen);
  for (let i = 0; i < byteLen; i++) buf[i] = Math.floor(Math.random() * 256);
  const text = Buffer.from(buf).toString('binary');
  return {
    captureId: generateUuidV7(),
    sourceApp: 'claude-code',
    sourceKind: 'jsonl_append',
    sourcePath: '/tmp/x.jsonl',
    sourcePathHash: 'a'.repeat(64),
    sourceInode: 1,
    watermarkKind: 'byte_range',
    watermarkStart: 0,
    watermarkEnd: byteLen,
    watermarkTable: null,
    agentSchemaVersion: '1.0',
    gatewayVersion: 'gw-0.1',
    capturedAtUtc: '2026-04-29T10:42:00.123Z',
    bodyFormat: 'jsonl',
    bodyCompression: 'zstd',
    body: zstdCompressSync(text),
  };
}

test('AUTH_FAILED sentinel skips capture', async () => {
  await writeAuthFailedSentinel(join(dir, 'AUTH_FAILED'), 'halt');
  const ctx = makeContext([noopSource('s')]);
  const result = await runCaptureCycle(ctx);
  expect(result.authFailed).toBe(true);
});

test('BUFFER_FULL sentinel skips capture (drain is the only way out)', async () => {
  await writeBufferFullSentinel(join(dir, 'BUFFER_FULL'), { pendingBytes: 1, threshold: 100 });
  let calls = 0;
  const ctx = makeContext([
    {
      name: 's',
      poll: async () => {
        calls++;
        return { filesProcessed: 0, capturedBatches: 0, capturedBytes: 0, errors: [] };
      },
    },
  ]);
  const result = await runCaptureCycle(ctx);
  expect(result.bufferFull).toBe(true);
  expect(calls).toBe(0);
});

test('runs all registered sources when not blocked', async () => {
  let a = 0;
  let b = 0;
  const ctx = makeContext([
    {
      name: 's-a',
      poll: async () => {
        a++;
        return { filesProcessed: 1, capturedBatches: 1, capturedBytes: 100, errors: [] };
      },
    },
    {
      name: 's-b',
      poll: async () => {
        b++;
        return { filesProcessed: 2, capturedBatches: 0, capturedBytes: 0, errors: [] };
      },
    },
  ]);
  const result = await runCaptureCycle(ctx);
  expect(a).toBe(1);
  expect(b).toBe(1);
  expect(result.sourceResults['s-a']?.filesProcessed).toBe(1);
  expect(result.sourceResults['s-b']?.filesProcessed).toBe(2);
});

test('writes BUFFER_FULL sentinel when pending exceeds soft-pause after capture', async () => {
  insertBatch(buffer, bigBatch(50_000));
  insertBatch(buffer, bigBatch(50_000));
  const ctx = makeContext([noopSource('s')], {
    bufferPolicy: {
      receiptRetentionDays: 30,
      failedRetentionDays: 30,
      softPauseBytes: 1024,
      softResumeBytes: 512,
    },
  });
  const result = await runCaptureCycle(ctx);
  expect(result.pressureResult?.shouldPause).toBe(true);
  expect(await isBufferFull(join(dir, 'BUFFER_FULL'))).toBe(true);
});

test('logs source.poll.error at error level for each source error', async () => {
  type Entry = { level: string; msg: string };
  const entries: Entry[] = [];
  const fakeLogger = makeFakeLogger(entries);
  const ctx = makeContext(
    [
      {
        name: 's',
        poll: async () => ({
          filesProcessed: 1,
          capturedBatches: 0,
          capturedBytes: 0,
          errors: [{ sourcePath: '/x', reason: 'boom' }],
        }),
      },
    ],
    { logger: fakeLogger },
  );
  await runCaptureCycle(ctx);
  expect(entries.some((e) => e.level === 'error' && e.msg.includes('source poll captured'))).toBe(
    true,
  );
});

test('persists capture cycle metrics: total, last_at, duration', async () => {
  const ctx = makeContext([noopSource('s')]);
  await runCaptureCycle(ctx);
  expect(getMetadata(buffer, METADATA_KEYS.captureCyclesTotal)).toBe('1');
  expect(getMetadata(buffer, METADATA_KEYS.captureLastCycleAt)).toMatch(/Z$/);
  expect(getMetadata(buffer, METADATA_KEYS.captureLastCycleDurationMs)).not.toBeNull();
  await runCaptureCycle(ctx);
  expect(getMetadata(buffer, METADATA_KEYS.captureCyclesTotal)).toBe('2');
});

test('persists sourceResults to daemon_state.last_source_captures', async () => {
  const ctx = makeContext([
    {
      name: 's-a',
      poll: async () => ({
        filesProcessed: 3,
        capturedBatches: 2,
        capturedBytes: 1024,
        errors: [{ sourcePath: '/x', reason: 'oops' }],
      }),
    },
    {
      name: 's-b',
      poll: async () => ({
        filesProcessed: 1,
        capturedBatches: 0,
        capturedBytes: 0,
        errors: [],
      }),
    },
  ]);
  await runCaptureCycle(ctx);
  const snap = getDaemonState(buffer);
  expect(snap?.lastSourceCaptures['s-a']).toEqual({
    filesProcessed: 3,
    capturedBatches: 2,
    capturedBytes: 1024,
    errorsCount: 1,
  });
  expect(snap?.lastSourceCaptures['s-b']).toEqual({
    filesProcessed: 1,
    capturedBatches: 0,
    capturedBytes: 0,
    errorsCount: 0,
  });
});

test('logs warn when daemon-state persist fails in capture', async () => {
  type Entry = { level: string; msg: string };
  const entries: Entry[] = [];
  const fakeLogger = makeFakeLogger(entries);
  buffer.exec('DROP TABLE daemon_state');
  const ctx = makeContext([noopSource('s')], { logger: fakeLogger });
  await runCaptureCycle(ctx);
  expect(
    entries.some((e) => e.level === 'warn' && e.msg.includes('failed to persist daemon')),
  ).toBe(true);
});

test('persists capture errors counter when source has errors', async () => {
  const ctx = makeContext([
    {
      name: 's',
      poll: async () => ({
        filesProcessed: 1,
        capturedBatches: 0,
        capturedBytes: 0,
        errors: [{ sourcePath: '/x', reason: 'boom' }],
      }),
    },
  ]);
  await runCaptureCycle(ctx);
  expect(getMetadata(buffer, METADATA_KEYS.captureCyclesWithErrors)).toBe('1');
});

test('logs warn when pressure check throws', async () => {
  type Entry = { level: string; msg: string };
  const entries: Entry[] = [];
  const fakeLogger = makeFakeLogger(entries);
  const ctx = makeContext([noopSource('s')], { logger: fakeLogger });
  buffer.exec('DROP TABLE upload_batches');
  await runCaptureCycle(ctx);
  expect(entries.some((e) => e.level === 'warn' && e.msg.includes('pressure check failed'))).toBe(
    true,
  );
});

test('logs warn when capture metrics persist fails', async () => {
  type Entry = { level: string; msg: string };
  const entries: Entry[] = [];
  const fakeLogger = makeFakeLogger(entries);
  setMetadata(buffer, METADATA_KEYS.captureCyclesTotal, 'not-a-number');
  const ctx = makeContext([noopSource('s')], { logger: fakeLogger });
  await runCaptureCycle(ctx);
  expect(getMetadata(buffer, METADATA_KEYS.captureCyclesTotal)).toBe('1');
});

test('logs warn when capture setMetadata throws (table dropped)', async () => {
  type Entry = { level: string; msg: string };
  const entries: Entry[] = [];
  const fakeLogger = makeFakeLogger(entries);
  buffer.exec('DROP TABLE buffer_metadata');
  const ctx = makeContext([noopSource('s')], { logger: fakeLogger });
  await runCaptureCycle(ctx);
  expect(
    entries.some((e) => e.level === 'warn' && e.msg.includes('failed to persist capture')),
  ).toBe(true);
});

test('uses minimumMtimeOverride when provided to source poll context', async () => {
  const override = new Date('2026-01-01T00:00:00.000Z');
  let captured: Date | null = null;
  const ctx = makeContext(
    [
      {
        name: 's',
        poll: async (sctx) => {
          captured = sctx.minimumMtimeOverride ?? null;
          return { filesProcessed: 0, capturedBatches: 0, capturedBytes: 0, errors: [] };
        },
      },
    ],
    { minimumMtimeOverride: override },
  );
  await runCaptureCycle(ctx);
  expect((captured as Date | null)?.toISOString()).toBe(override.toISOString());
});

interface FakeLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  fatal: (...args: unknown[]) => void;
  trace: (...args: unknown[]) => void;
  child: (bindings: Record<string, unknown>) => FakeLogger;
}

function makeFakeLogger(entries: { level: string; msg: string }[]): FakeLogger {
  function record(level: string): (...args: unknown[]) => void {
    return (...args: unknown[]) => {
      const last = args[args.length - 1];
      const msg = typeof last === 'string' ? last : JSON.stringify(last);
      entries.push({ level, msg });
    };
  }
  const logger: FakeLogger = {
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    debug: record('debug'),
    fatal: record('fatal'),
    trace: record('trace'),
    child: () => logger,
  };
  return logger;
}

test('capture-cycle runs worker successfully with cursors, batches, quarantine', async () => {
  const originalWorker = globalThis.Worker;
  globalThis.Worker = asWorkerCtor(
    class MockWorker {
      onmessage: WorkerMessageHandler = null;
      onerror: WorkerErrorHandler = null;
      postMessage(_message: WorkerInput): void {
        setTimeout(() => {
          if (this.onmessage) {
            this.onmessage(
              asMessageEvent({
                data: {
                  sourceName: 'cursor',
                  success: true,
                  captureResult: {
                    filesProcessed: 3,
                    capturedBytes: 150,
                    batches: [
                      {
                        captureId: generateUuidV7(),
                        sourceApp: 'cursor',
                        sourcePlatform: 'cursor-ide',
                        sourceKind: 'sqlite_kv_snapshot',
                        sourcePath: '/tmp/c.db',
                        sourcePathHash: 'b'.repeat(64),
                        sourceInode: 2,
                        watermarkKind: 'rowid_range',
                        watermarkStart: 1,
                        watermarkEnd: 10,
                        watermarkTable: 'workspace_tabs',
                        agentSchemaVersion: '1.0',
                        gatewayVersion: 'gw-0.1',
                        capturedAtUtc: '2026-05-08T00:00:00Z',
                        bodyFormat: 'jsonl',
                        bodyCompression: 'zstd',
                        body: zstdCompressSync('[]'),
                      },
                    ],
                    quarantine: [
                      {
                        sourceApp: 'cursor',
                        sourcePath: '/tmp/c.db',
                        sourcePathHash: 'b'.repeat(64),
                        sourceInode: 2,
                        watermarkTable: 'workspace_tabs',
                        watermarkPosition: 15,
                        rowPk: 'pk1',
                        redactedSizeBytes: 1000,
                        reason: 'too big',
                        quarantinedAtUtc: '2026-05-08T00:00:00Z',
                        gatewayVersion: 'gw-0.1',
                      },
                    ],
                    cursors: [
                      {
                        sourcePathHash: 'b'.repeat(64),
                        sourcePath: '/tmp/c.db',
                        sourceInode: 2,
                        watermarkTable: 'workspace_tabs',
                        watermarkEnd: 15,
                        lastSeenSizeBytes: 2000,
                        lastSeenPageCount: 1,
                        consecutiveErrors: 0,
                      },
                      {
                        sourcePathHash: 'c'.repeat(64),
                        sourcePath: '/tmp/d.db',
                        sourceInode: 3,
                        watermarkTable: 'workspace_tabs',
                        watermarkEnd: 15,
                        lastSeenSizeBytes: 2000,
                        lastSeenPageCount: 1,
                        consecutiveErrors: 1,
                      },
                    ],
                  },
                },
              }),
            );
          }
        }, 0);
      }
      terminate(): void {}
    },
  );

  try {
    const ctx = makeContext([{ name: 'cursor', poll: stubPoll }]);
    ctx.buffer
      .query(
        `
      INSERT INTO source_cursors (
        source_app, source_path_hash, source_path, source_inode, watermark_table, watermark_end, last_seen_size_bytes, last_seen_page_count, consecutive_errors, last_polled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        'cursor',
        'a'.repeat(64),
        '/tmp/a.db',
        1,
        'workspace_tabs',
        5,
        1000,
        1,
        0,
        '2026-05-08T00:00:00Z',
      );
    const result = await runCaptureCycle(ctx);
    expect(result.sourceResults['cursor']?.filesProcessed).toBe(3);
    expect(result.sourceResults['cursor']?.capturedBatches).toBe(1);
    expect(result.sourceResults['cursor']?.errors.length).toBe(0);
  } finally {
    globalThis.Worker = originalWorker;
  }
});

test('capture-cycle forwards source.baseDir into worker options when defined', async () => {
  const originalWorker = globalThis.Worker;
  let receivedBaseDir: string | undefined = undefined;
  globalThis.Worker = asWorkerCtor(
    class MockWorker {
      onmessage: WorkerMessageHandler = null;
      postMessage(message: WorkerInput): void {
        receivedBaseDir = message.options.baseDir;
        setTimeout(() => {
          if (this.onmessage) {
            this.onmessage(
              asMessageEvent({
                data: {
                  sourceName: 'cursor',
                  success: true,
                  captureResult: {
                    filesProcessed: 0,
                    capturedBytes: 0,
                    batches: [],
                    quarantine: [],
                    cursors: [],
                  },
                },
              }),
            );
          }
        }, 0);
      }
      terminate(): void {}
    },
  );

  try {
    const ctx = makeContext([{ name: 'cursor', poll: stubPoll, baseDir: '/tmp/custom-base' }]);
    await runCaptureCycle(ctx);
    expect(receivedBaseDir as string | undefined).toBe('/tmp/custom-base');
  } finally {
    globalThis.Worker = originalWorker;
  }
});

test('capture-cycle handles worker success: false', async () => {
  const originalWorker = globalThis.Worker;
  globalThis.Worker = asWorkerCtor(
    class MockWorker {
      onmessage: WorkerMessageHandler = null;
      postMessage(_message: WorkerInput): void {
        setTimeout(() => {
          if (this.onmessage) {
            this.onmessage(
              asMessageEvent({
                data: {
                  sourceName: 'cursor',
                  success: false,
                  error: 'Worker error message',
                },
              }),
            );
          }
        }, 0);
      }
      terminate(): void {}
    },
  );

  try {
    const ctx = makeContext([{ name: 'cursor', poll: stubPoll }]);
    const result = await runCaptureCycle(ctx);
    expect(result.sourceResults['cursor']?.filesProcessed).toBe(0);
    expect(result.sourceResults['cursor']?.errors[0]?.reason).toBe('Worker error message');
  } finally {
    globalThis.Worker = originalWorker;
  }
});

test('capture-cycle handles worker missing captureResult', async () => {
  const originalWorker = globalThis.Worker;
  globalThis.Worker = asWorkerCtor(
    class MockWorker {
      onmessage: WorkerMessageHandler = null;
      postMessage(_message: WorkerInput): void {
        setTimeout(() => {
          if (this.onmessage) {
            this.onmessage(
              asMessageEvent({
                data: { sourceName: 'cursor', success: true },
              }),
            );
          }
        }, 0);
      }
      terminate(): void {}
    },
  );

  try {
    const ctx = makeContext([{ name: 'cursor', poll: stubPoll }]);
    const result = await runCaptureCycle(ctx);
    expect(result.sourceResults['cursor']?.filesProcessed).toBe(0);
    expect(result.sourceResults['cursor']?.capturedBatches).toBe(0);
  } finally {
    globalThis.Worker = originalWorker;
  }
});

test('capture-cycle handles worker db transaction failure', async () => {
  const originalWorker = globalThis.Worker;
  globalThis.Worker = asWorkerCtor(
    class MockWorker {
      onmessage: WorkerMessageHandler = null;
      postMessage(_message: WorkerInput): void {
        setTimeout(() => {
          if (this.onmessage) {
            const invalidShape: unknown = {
              captureId: 'invalid-uuid-violating-db',
              sourceApp: 'cursor',
              sourceKind: 'sqlite_kv_snapshot',
              sourcePath: '/tmp/c.db',
              sourcePathHash: 'b'.repeat(64),
              sourceInode: 2,
              watermarkKind: 'rowid_range',
              watermarkStart: 1,
              watermarkEnd: 10,
              watermarkTable: 'workspace_tabs',
              agentSchemaVersion: '1.0',
              gatewayVersion: 'gw-0.1',
              capturedAtUtc: '2026-05-08T00:00:00Z',
              bodyFormat: 'jsonl',
              bodyCompression: 'zstd',
              body: null,
            };
            const invalidBatch =
              invalidShape as Required<WorkerOutput>['captureResult']['batches'][number];
            this.onmessage(
              asMessageEvent({
                data: {
                  sourceName: 'cursor',
                  success: true,
                  captureResult: {
                    filesProcessed: 1,
                    capturedBytes: 10,
                    batches: [invalidBatch],
                    quarantine: [],
                    cursors: [],
                  },
                },
              }),
            );
          }
        }, 0);
      }
      terminate(): void {}
    },
  );

  try {
    const ctx = makeContext([{ name: 'cursor', poll: stubPoll }]);
    const result = await runCaptureCycle(ctx);
    expect(result.sourceResults['cursor']?.capturedBatches).toBe(0);
    expect(result.sourceResults['cursor']?.errors.length).toBe(1);
  } finally {
    globalThis.Worker = originalWorker;
  }
});

test('capture-cycle handles worker onerror event', async () => {
  const originalWorker = globalThis.Worker;
  globalThis.Worker = asWorkerCtor(
    class MockWorker {
      onerror: WorkerErrorHandler = null;
      postMessage(_message: WorkerInput): void {
        setTimeout(() => {
          if (this.onerror) {
            this.onerror(new ErrorEvent('error', { message: 'worker syntax error' }));
          }
        }, 0);
      }
      terminate(): void {}
    },
  );

  try {
    const ctx = makeContext([{ name: 'cursor', poll: stubPoll }]);
    const result = await runCaptureCycle(ctx);
    expect(result.sourceResults['cursor']?.filesProcessed).toBe(0);
    expect(result.sourceResults['cursor']?.errors[0]?.reason).toBe('worker syntax error');
  } finally {
    globalThis.Worker = originalWorker;
  }
});

test('capture-cycle handles worker construction throws exception', async () => {
  const originalWorker = globalThis.Worker;
  globalThis.Worker = asWorkerCtor(
    class MockWorker {
      constructor(..._args: unknown[]) {
        throw new Error('Worker constructor boom');
      }
      postMessage(_message: WorkerInput): void {}
      terminate(): void {}
    },
  );

  try {
    const ctx = makeContext([{ name: 'cursor', poll: stubPoll }]);
    const result = await runCaptureCycle(ctx);
    expect(result.sourceResults['cursor']?.filesProcessed).toBe(0);
    expect(result.sourceResults['cursor']?.errors[0]?.reason).toBe('Worker constructor boom');
  } finally {
    globalThis.Worker = originalWorker;
  }
});

test('capture-cycle handles assertSourceApp throwing Unknown source app error', async () => {
  __deps.VALID_SOURCE_APPS = [];
  try {
    const ctx = makeContext([{ name: 'cursor', poll: stubPoll }]);
    const result = await runCaptureCycle(ctx);
    expect(result.sourceResults['cursor']?.errors[0]?.reason).toContain(
      'Unknown source app: cursor',
    );
  } finally {
    __deps.VALID_SOURCE_APPS = origValidSourceApps;
  }
});

test('capture-cycle runInProcessWorker covers compile check and in-process execution with null capture', async () => {
  __deps.isCompiledBinary = () => true;
  __deps.handleCapture = (async () => null) as unknown as typeof __deps.handleCapture;

  const ctx = makeContext([{ name: 'cursor', poll: stubPoll }]);
  const result = await runCaptureCycle(ctx);
  expect(result.sourceResults['cursor']?.capturedBatches).toBe(0);
});

test('capture-cycle runInProcessWorker covers compile check and in-process execution with valid capture bundle and baseDir', async () => {
  __deps.isCompiledBinary = () => true;

  const mockBundle = {
    filesProcessed: 1,
    capturedBytes: 100,
    batches: [
      {
        captureId: generateUuidV7(),
        sourceApp: 'cursor',
        sourceKind: 'sqlite_kv_snapshot',
        sourcePath: '/tmp/c.db',
        sourcePathHash: 'b'.repeat(64),
        sourceInode: 2,
        watermarkKind: 'rowid_range',
        watermarkStart: 1,
        watermarkEnd: 10,
        watermarkTable: 'workspace_tabs',
        agentSchemaVersion: '1.0',
        gatewayVersion: 'gw-0.1',
        capturedAtUtc: '2026-05-08T00:00:00Z',
        bodyFormat: 'jsonl',
        bodyCompression: 'zstd',
        body: zstdCompressSync('[]'),
      },
    ],
    quarantine: [],
    cursors: [
      {
        sourcePathHash: 'b'.repeat(64),
        sourcePath: '/tmp/c.db',
        sourceInode: 2,
        watermarkTable: 'workspace_tabs',
        watermarkEnd: 15,
        lastSeenSizeBytes: 2000,
        lastSeenPageCount: 1,
        consecutiveErrors: 0,
      },
    ],
  };

  __deps.handleCapture = (async () => mockBundle) as unknown as typeof __deps.handleCapture;

  const ctx = makeContext([{ name: 'cursor', poll: stubPoll, baseDir: '/tmp/custom-dir' }]);
  const result = await runCaptureCycle(ctx);
  expect(result.sourceResults['cursor']?.capturedBatches).toBe(1);
});

test('capture-cycle handles synchronous error in pollSourceInWorker catch block', async () => {
  const closedDb = openInMemoryBufferDb();
  closedDb.close();

  const ctx = makeContext([{ name: 'cursor', poll: stubPoll }], { buffer: closedDb });
  const result = await runCaptureCycle(ctx);
  expect(result.sourceResults['cursor']?.errors.length).toBe(1);
  expect(result.sourceResults['cursor']?.errors[0]?.reason).toContain('closed');
});

function emptyCaptureWorker(postedInputs: WorkerInput[], sourceName: string): typeof Worker {
  return asWorkerCtor(
    class MockWorker {
      onmessage: WorkerMessageHandler = null;
      onerror: WorkerErrorHandler = null;
      postMessage(message: WorkerInput): void {
        postedInputs.push(message);
        setTimeout(() => {
          if (this.onmessage) {
            this.onmessage(
              asMessageEvent({
                data: {
                  sourceName,
                  success: true,
                  captureResult: {
                    filesProcessed: 0,
                    capturedBytes: 0,
                    batches: [],
                    quarantine: [],
                    cursors: [],
                  },
                },
              }),
            );
          }
        }, 0);
      }
      terminate(): void {}
    },
  );
}

test('threads desktopCliSessionIds into the in-process claude-code worker options', async () => {
  __deps.isCompiledBinary = () => true;
  let seen: ReadonlySet<string> | undefined;
  __deps.handleCapture = (async (_name: string, options: WorkerInput['options']) => {
    seen = options.desktopCliSessionIds;
    return null;
  }) as unknown as typeof __deps.handleCapture;

  const ids = new Set(['sess-a']);
  const ctx = makeContext([{ name: 'claude-code', poll: stubPoll }], {
    loadDesktopCliSessionIds: async () => ids,
  });
  await runCaptureCycle(ctx);
  expect(seen).toBe(ids);
});

test('threads desktopCliSessionIds into the claude-code worker options', async () => {
  __deps.isCompiledBinary = () => false;
  const originalWorker = globalThis.Worker;
  const postedInputs: WorkerInput[] = [];
  globalThis.Worker = emptyCaptureWorker(postedInputs, 'claude-code');

  try {
    const ids = new Set(['sess-a']);
    const ctx = makeContext([{ name: 'claude-code', poll: stubPoll }], {
      loadDesktopCliSessionIds: async () => ids,
    });
    await runCaptureCycle(ctx);
    expect(postedInputs[0]?.options.desktopCliSessionIds).toBe(ids);
  } finally {
    globalThis.Worker = originalWorker;
  }
});

test('does not thread desktopCliSessionIds into non claude-code workers', async () => {
  __deps.isCompiledBinary = () => false;
  const originalWorker = globalThis.Worker;
  const postedInputs: WorkerInput[] = [];
  globalThis.Worker = emptyCaptureWorker(postedInputs, 'cursor');

  try {
    const ctx = makeContext([{ name: 'cursor', poll: stubPoll }], {
      loadDesktopCliSessionIds: async () => new Set(['sess-a']),
    });
    await runCaptureCycle(ctx);
    expect(postedInputs[0]?.options.desktopCliSessionIds).toBeUndefined();
  } finally {
    globalThis.Worker = originalWorker;
  }
});

test('continues capture when loadDesktopCliSessionIds throws', async () => {
  __deps.isCompiledBinary = () => false;
  const originalWorker = globalThis.Worker;
  const postedInputs: WorkerInput[] = [];
  globalThis.Worker = emptyCaptureWorker(postedInputs, 'claude-code');

  const warnings: string[] = [];
  const logger = {
    info: () => undefined,
    debug: () => undefined,
    warn: (obj: unknown) => {
      const event = (obj as { event?: unknown }).event;
      if (typeof event === 'string') warnings.push(event);
    },
    error: () => undefined,
    fatal: () => undefined,
    trace: () => undefined,
    child: () => logger,
  };

  try {
    const ctx = makeContext([{ name: 'claude-code', poll: stubPoll }], {
      loadDesktopCliSessionIds: async () => {
        throw new Error('sidecar boom');
      },
      logger,
    });
    await runCaptureCycle(ctx);
    expect(postedInputs[0]?.options.desktopCliSessionIds).toBeUndefined();
    expect(warnings).toContain('capture.desktop_sidecar_failed');
  } finally {
    globalThis.Worker = originalWorker;
  }
});

test('threads excludedProjects into the in-process claude-code worker options', async () => {
  __deps.isCompiledBinary = () => true;
  let seen: readonly string[] | undefined;
  __deps.handleCapture = (async (_name: string, options: WorkerInput['options']) => {
    seen = options.excludedProjects;
    return null;
  }) as unknown as typeof __deps.handleCapture;

  const list = ['/Users/me/secret'];
  const ctx = makeContext([{ name: 'claude-code', poll: stubPoll }], {
    loadExcludedProjects: async () => list,
  });
  await runCaptureCycle(ctx);
  expect(seen).toEqual(list);
});

test('threads excludedProjects into the threaded claude-code worker options', async () => {
  __deps.isCompiledBinary = () => false;
  const originalWorker = globalThis.Worker;
  const postedInputs: WorkerInput[] = [];
  globalThis.Worker = emptyCaptureWorker(postedInputs, 'claude-code');
  try {
    const list = ['/Users/me/secret'];
    const ctx = makeContext([{ name: 'claude-code', poll: stubPoll }], {
      loadExcludedProjects: async () => list,
    });
    await runCaptureCycle(ctx);
    expect(postedInputs[0]?.options.excludedProjects).toEqual(list);
  } finally {
    globalThis.Worker = originalWorker;
  }
});

test('continues capture when loadExcludedProjects throws', async () => {
  __deps.isCompiledBinary = () => false;
  const originalWorker = globalThis.Worker;
  const postedInputs: WorkerInput[] = [];
  globalThis.Worker = emptyCaptureWorker(postedInputs, 'claude-code');
  const warnings: string[] = [];
  const logger = {
    info: () => undefined,
    debug: () => undefined,
    warn: (obj: unknown) => {
      const event = (obj as { event?: unknown }).event;
      if (typeof event === 'string') warnings.push(event);
    },
    error: () => undefined,
    fatal: () => undefined,
    trace: () => undefined,
    child: () => logger,
  };
  try {
    const ctx = makeContext([{ name: 'claude-code', poll: stubPoll }], {
      loadExcludedProjects: async () => {
        throw new Error('exclude boom');
      },
      logger,
    });
    await runCaptureCycle(ctx);
    expect(postedInputs[0]?.options.excludedProjects).toBeUndefined();
    expect(warnings).toContain('capture.exclusions_load_failed');
  } finally {
    globalThis.Worker = originalWorker;
  }
});

test('threaded worker forwards desktopCliSessionIds for the claude-code source', async () => {
  __deps.isCompiledBinary = () => false;
  const originalWorker = globalThis.Worker;
  const postedInputs: WorkerInput[] = [];
  globalThis.Worker = asWorkerCtor(
    class MockWorker {
      onmessage: WorkerMessageHandler = null;
      onerror: WorkerErrorHandler = null;
      postMessage(message: WorkerInput): void {
        postedInputs.push(message);
        setTimeout(() => {
          if (this.onmessage) {
            this.onmessage(
              asMessageEvent({
                data: {
                  sourceName: 'claude-code',
                  success: true,
                  captureResult: {
                    filesProcessed: 0,
                    capturedBytes: 0,
                    batches: [],
                    quarantine: [],
                    cursors: [],
                  },
                },
              }),
            );
          }
        }, 0);
      }
      terminate(): void {}
    },
  );

  try {
    const ids = new Set(['sess-threaded']);
    const ctx = makeContext([{ name: 'claude-code', poll: stubPoll }], {
      loadDesktopCliSessionIds: async () => ids,
    });
    await runCaptureCycle(ctx);
    expect(postedInputs.length).toBe(1);
    expect(postedInputs[0]?.options.desktopCliSessionIds).toBe(ids);
  } finally {
    globalThis.Worker = originalWorker;
  }
});
