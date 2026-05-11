import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Logger } from 'core/log';
import type { Database } from 'bun:sqlite';
import { rmRecursive } from 'core/io/fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateUuidV7, zstdCompressSync } from 'core/utils';
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
  pausePolling,
  persistAcceptedBySource,
  runCaptureCycle,
  writeAuthFailedSentinel,
  writeBufferFullSentinel,
} from 'services/polling';
import type { CaptureCycleContext, RegisteredSource } from 'services/polling';

let dir: string;
let buffer: Database;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-capture-cycle-'));
  buffer = openInMemoryBufferDb();
});

afterEach(async () => {
  buffer.close();
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
    pauseSentinelPath: join(dir, 'PAUSED'),
    authFailedSentinelPath: join(dir, 'AUTH_FAILED'),
    bufferFullSentinelPath: join(dir, 'BUFFER_FULL'),
    bufferPolicy: {
      receiptRetentionDays: 30,
      failedRetentionDays: 30,
      softPauseBytes: 700 * 1024 * 1024,
      softResumeBytes: 600 * 1024 * 1024,
    },
    capturePolicy: { initialScanWindowDays: 30, maxDecompressedBytes: 9 * 1024 * 1024 },
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

test('paused sentinel skips capture', async () => {
  await pausePolling(join(dir, 'PAUSED'), 'manual');
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
  expect(result.paused).toBe(true);
  expect(calls).toBe(0);
  expect(result.sourceResults).toEqual({});
});

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
    { logger: fakeLogger as unknown as Logger },
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
  const ctx = makeContext([noopSource('s')], { logger: fakeLogger as unknown as Logger });
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

test('persistAcceptedBySource increments per-source counters', () => {
  setMetadata(buffer, 'upload_batches_shipped_by_source.claude-code', '5');
  persistAcceptedBySource(buffer, {
    'claude-code': { batches: 3, bytes: 100 },
    cursor: { batches: 1, bytes: 50 },
  });
  expect(getMetadata(buffer, 'upload_batches_shipped_by_source.claude-code')).toBe('8');
  expect(getMetadata(buffer, 'upload_bytes_shipped_by_source.claude-code')).toBe('100');
  expect(getMetadata(buffer, 'upload_batches_shipped_by_source.cursor')).toBe('1');
});

test('persistAcceptedBySource skips undefined entries', () => {
  persistAcceptedBySource(buffer, {
    'claude-code': { batches: 2, bytes: 30 },
    cursor: undefined,
  });
  expect(getMetadata(buffer, 'upload_batches_shipped_by_source.claude-code')).toBe('2');
  expect(getMetadata(buffer, 'upload_batches_shipped_by_source.cursor')).toBeNull();
});

test('logs warn when pressure check throws', async () => {
  type Entry = { level: string; msg: string };
  const entries: Entry[] = [];
  const fakeLogger = makeFakeLogger(entries);
  const ctx = makeContext([noopSource('s')], { logger: fakeLogger as unknown as Logger });
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
  const ctx = makeContext([noopSource('s')], { logger: fakeLogger as unknown as Logger });
  await runCaptureCycle(ctx);
  expect(getMetadata(buffer, METADATA_KEYS.captureCyclesTotal)).toBe('1');
});

test('logs warn when capture setMetadata throws (table dropped)', async () => {
  type Entry = { level: string; msg: string };
  const entries: Entry[] = [];
  const fakeLogger = makeFakeLogger(entries);
  buffer.exec('DROP TABLE buffer_metadata');
  const ctx = makeContext([noopSource('s')], { logger: fakeLogger as unknown as Logger });
  await runCaptureCycle(ctx);
  expect(
    entries.some((e) => e.level === 'warn' && e.msg.includes('failed to persist capture')),
  ).toBe(true);
});

test('paused cycle without logger returns gracefully', async () => {
  await pausePolling(join(dir, 'PAUSED'), 'manual');
  const ctx = makeContext([noopSource('s')]);
  const result = await runCaptureCycle(ctx);
  expect(result.paused).toBe(true);
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
    child: () => logger,
  };
  return logger;
}
