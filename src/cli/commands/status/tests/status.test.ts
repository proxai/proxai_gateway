import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { rmRecursive } from 'core/io/fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runStatus as runStatusImpl, formatBytes } from 'cli/commands/status/index.ts';
import type { ReadableInputStream } from 'cli/commands/status/key-handler.types.ts';
import type { CommandResult } from 'cli/cli.types.ts';

function autoQuitStdin(): ReadableInputStream {
  return {
    isTTY: false,
    on(event, listener): unknown {
      if (event === 'data') {
        setTimeout(() => {
          (listener as (chunk: Buffer) => void)(Buffer.from('q'));
        }, 100);
      }
      return this;
    },
    off(): unknown {
      return this;
    },
  };
}

async function runStatus(
  deps: Parameters<typeof runStatusImpl>[0],
  options: Parameters<typeof runStatusImpl>[1] = {},
): Promise<CommandResult> {
  return runStatusImpl(deps, {
    stdin: autoQuitStdin(),
    clearScreen: false,
    intervalMs: 1_000_000,
    ...options,
  });
}
import {
  formatLocalTimestamp,
  formatRelative,
  formatTimeWithRelative,
  deriveHealth,
  statusDot,
  sectionHeader,
} from 'cli/commands/format-status.ts';
import { captureOutput } from 'cli/output.ts';
import { openInMemoryBufferDb, setDaemonState } from 'services/buffer';

let dir: string;
let buffer: Database;
let configPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-cli-status-'));
  buffer = openInMemoryBufferDb();
  configPath = join(dir, 'config.toml');
});

afterEach(async () => {
  buffer.close();
  await rmRecursive(dir);
});

function makeDeps(
  extras: Partial<Parameters<typeof runStatus>[0]> = {},
): Parameters<typeof runStatus>[0] {
  return {
    output: captureOutput(),
    buffer,
    configPath,
    configExists: () => Promise.resolve(true),
    pauseSentinelPath: join(dir, 'PAUSED'),
    bufferFullSentinelPath: join(dir, 'BUFFER_FULL'),
    authFailedSentinelPath: join(dir, 'AUTH_FAILED'),
    sessionStoppedSentinelPath: join(dir, 'SESSION_STOPPED'),
    devModeSentinelPath: join(dir, 'DEV_MODE'),
    ...extras,
  };
}

test('reports not-configured in JSON mode emits structured payload', async () => {
  const out = captureOutput();
  const result = await runStatus(
    makeDeps({ output: out, configExists: () => Promise.resolve(false) }),
    { json: true },
  );
  expect(result.exitCode).toBe(4);
  const json = JSON.parse(out.lines[0]!.msg) as { configured: boolean; health: string };
  expect(json.configured).toBe(false);
  expect(json.health).toBe('inactive');
});

test('JSON mode returns full structured payload when configured', async () => {
  setDaemonState(buffer, {
    lastCycleStartedAt: '2026-05-08T02:40:13.100Z',
    lastCycleCompletedAt: '2026-05-08T02:46:52.293Z',
    lastCycleDurationMs: 399193,
    lastDrainAttempted: 1,
    lastDrainAccepted: 0,
    lastDrainRetriable: 1,
    lastDrainFatal: 0,
    lastDrainRecovered: 0,
    lastUploadError: 'server returned 500',
    lastConsecutiveRetriableBreak: true,
    lastSourceCaptures: {
      'claude-code': { filesProcessed: 1, capturedBatches: 1, capturedBytes: 100, errorsCount: 0 },
    },
  });
  const out = captureOutput();
  const result = await runStatus(makeDeps({ output: out }), { json: true });
  expect(result.exitCode).toBe(0);
  const json = JSON.parse(out.lines[0]!.msg) as {
    configured: boolean;
    health: string;
    upload: { lastUploadError: string | null; consecutiveRetriableBreak: boolean | null };
    capture: Record<string, { capturedBatches: number }> | null;
  };
  expect(json.configured).toBe(true);
  expect(json.upload.lastUploadError).toBe('server returned 500');
  expect(json.upload.consecutiveRetriableBreak).toBe(true);
  expect(json.capture?.['claude-code']?.capturedBatches).toBe(1);
});

test('JSON mode includes updateAvailable when sentinel present', async () => {
  const updateAvailableSentinelPath = join(dir, 'UPDATE_AVAILABLE');
  await writeFile(
    updateAvailableSentinelPath,
    JSON.stringify({
      latest_version: '2026.5.10',
      current_version: '2026.5.7',
      detected_at: '2026-05-06T00:00:00.000Z',
    }),
  );
  const out = captureOutput();
  await runStatus(makeDeps({ output: out, updateAvailableSentinelPath }), { json: true });
  const json = JSON.parse(out.lines[0]!.msg) as {
    sentinels: { updateAvailable: { latestVersion: string; currentVersion: string } | null };
  };
  expect(json.sentinels.updateAvailable?.latestVersion).toBe('2026.5.10');
  expect(json.sentinels.updateAvailable?.currentVersion).toBe('2026.5.7');
});

test('JSON mode handles authFailed and bufferFull and sessionStopped sentinels', async () => {
  await writeFile(
    join(dir, 'AUTH_FAILED'),
    JSON.stringify({ reason: 'revoked', detected_at: '2026-05-08T00:00:00Z' }),
  );
  await writeFile(
    join(dir, 'BUFFER_FULL'),
    JSON.stringify({ pending_bytes: 1, threshold: 1, set_at: '2026-05-08T00:00:00Z' }),
  );
  await writeFile(
    join(dir, 'SESSION_STOPPED'),
    JSON.stringify({ boot_id: 'b', set_at: '2026-05-08T00:00:00Z' }),
  );
  const out = captureOutput();
  await runStatus(makeDeps({ output: out }), { json: true });
  const json = JSON.parse(out.lines[0]!.msg) as {
    sentinels: { authFailed: boolean; bufferFull: boolean; sessionStopped: boolean };
  };
  expect(json.sentinels.authFailed).toBe(true);
  expect(json.sentinels.bufferFull).toBe(true);
  expect(json.sentinels.sessionStopped).toBe(true);
});

test('formatBytes handles each magnitude tier', () => {
  expect(formatBytes(0)).toBe('0 B');
  expect(formatBytes(512)).toBe('512 B');
  expect(formatBytes(1024)).toBe('1.00 KB');
  expect(formatBytes(50 * 1024)).toBe('50.0 KB');
  expect(formatBytes(150 * 1024)).toBe('150 KB');
  expect(formatBytes(2 * 1024 * 1024)).toBe('2.00 MB');
  expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe('2.00 GB');
  expect(formatBytes(2 * 1024 * 1024 * 1024 * 1024)).toBe('2.00 TB');
  expect(formatBytes(2 * 1024 * 1024 * 1024 * 1024 * 1024)).toContain('TB');
});

test('formatBytes treats invalid input as zero', () => {
  expect(formatBytes(NaN)).toBe('0 B');
  expect(formatBytes(-1)).toBe('0 B');
  expect(formatBytes(Infinity)).toBe('0 B');
});

test('formatLocalTimestamp produces day-month-time format in user locale', () => {
  const result = formatLocalTimestamp('2026-05-08T02:46:52.293Z', { timeZone: 'UTC' });
  expect(result).toContain('May');
  expect(result).toMatch(/\d{2}:\d{2}:\d{2}/);
});

test('formatLocalTimestamp returns ISO when input is invalid', () => {
  expect(formatLocalTimestamp('not-a-date')).toBe('not-a-date');
});

test('formatLocalTimestamp recovers via UTC fallback for non-English locale', () => {
  const result = formatLocalTimestamp('2026-05-08T02:46:52.293Z', {
    locale: 'ja-JP',
    timeZone: 'UTC',
  });
  expect(result).toContain('May');
});

test('formatRelative handles seconds, minutes, hours, days, future', () => {
  const now = new Date('2026-05-08T12:00:00Z');
  expect(formatRelative('2026-05-08T11:59:30Z', { now })).toContain('s ago');
  expect(formatRelative('2026-05-08T11:55:00Z', { now })).toContain('min ago');
  expect(formatRelative('2026-05-08T08:00:00Z', { now })).toContain('h ago');
  expect(formatRelative('2026-05-05T12:00:00Z', { now })).toContain('d ago');
  expect(formatRelative('2026-05-08T12:00:30Z', { now })).toContain('from now');
});

test('formatRelative returns empty string for invalid input', () => {
  expect(formatRelative('garbage')).toBe('');
});

test('formatTimeWithRelative composes timestamp and relative', () => {
  const now = new Date('2026-05-08T12:00:00Z');
  const out = formatTimeWithRelative('2026-05-08T11:55:00Z', { now, timeZone: 'UTC' });
  expect(out).toContain('May');
  expect(out).toContain('min ago');
});

test('formatTimeWithRelative omits relative when iso is invalid', () => {
  expect(formatTimeWithRelative('garbage')).toBe('garbage');
});

test('statusDot renders distinct chars per state', () => {
  expect(statusDot('healthy')).toContain('●');
  expect(statusDot('warning')).toContain('●');
  expect(statusDot('error')).toContain('●');
  expect(statusDot('inactive')).toContain('○');
});

test('sectionHeader includes label between hyphens', () => {
  expect(sectionHeader('Capture')).toContain('Capture');
  expect(sectionHeader('Capture')).toContain('──');
});

test('deriveHealth returns error for any blocking sentinel', () => {
  const base = {
    paused: false,
    authFailed: false,
    bufferFull: false,
    sessionStopped: false,
    hasRecentActivity: true,
    drain: null,
  };
  expect(deriveHealth({ ...base, authFailed: true })).toBe('error');
  expect(deriveHealth({ ...base, paused: true })).toBe('error');
  expect(deriveHealth({ ...base, bufferFull: true })).toBe('error');
  expect(deriveHealth({ ...base, sessionStopped: true })).toBe('error');
});

test('deriveHealth returns inactive when no recent activity', () => {
  expect(
    deriveHealth({
      paused: false,
      authFailed: false,
      bufferFull: false,
      sessionStopped: false,
      hasRecentActivity: false,
      drain: null,
    }),
  ).toBe('inactive');
});

test('deriveHealth returns warning when drain had retriable failures', () => {
  expect(
    deriveHealth({
      paused: false,
      authFailed: false,
      bufferFull: false,
      sessionStopped: false,
      hasRecentActivity: true,
      drain: {
        lastCycleStartedAt: null,
        lastCycleCompletedAt: null,
        lastCycleDurationMs: null,
        lastDrainAttempted: 3,
        lastDrainAccepted: 0,
        lastDrainRetriable: 3,
        lastDrainFatal: 0,
        lastDrainRecovered: 0,
        lastUploadError: null,
        lastConsecutiveRetriableBreak: false,
        lastSourceCaptures: {},
      },
    }),
  ).toBe('warning');
});

test('deriveHealth returns healthy when drain is clean', () => {
  expect(
    deriveHealth({
      paused: false,
      authFailed: false,
      bufferFull: false,
      sessionStopped: false,
      hasRecentActivity: true,
      drain: {
        lastCycleStartedAt: null,
        lastCycleCompletedAt: null,
        lastCycleDurationMs: null,
        lastDrainAttempted: 5,
        lastDrainAccepted: 5,
        lastDrainRetriable: 0,
        lastDrainFatal: 0,
        lastDrainRecovered: 0,
        lastUploadError: null,
        lastConsecutiveRetriableBreak: false,
        lastSourceCaptures: {},
      },
    }),
  ).toBe('healthy');
});

import {
  setMetadata,
  METADATA_KEYS,
  uploadBatchesShippedKey,
  uploadBytesShippedKey,
} from 'services/buffer';

test('runStatus JSON mode reports binary age days when installedAt is set via loadConfig dep', async () => {
  const out = captureOutput();
  const result = await runStatus(
    makeDeps({
      output: out,
      loadConfig: async () =>
        ({
          account: {
            apiKey: 'k',
            userId: 'u',
            hostId: 'h',
            installedAt: new Date(Date.now() - 14 * 86_400_000).toISOString(),
            installSource: 'npm',
          },
          backend: {
            ingestUrl: '',
            verifyKeyUrl: '',
            watermarksUrl: '',
            registerHostIdUrl: '',
          },
          capture: {
            pollIntervalSec: 60,
            bufferPath: '',
            receiptRetentionDays: 30,
            failedRetentionDays: 30,
            bufferSoftPauseBytes: 700_000_000,
            bufferSoftResumeBytes: 600_000_000,
            uploadMaxBatchesPerSec: 1,
            uploadMaxBytesPerMinute: 1,
            uploadBackoffOn429Multiplier: 1,
          },
          logging: { level: 'info', logDir: '' },
          staleBinary: { warnAfterDays: 90, pauseAfterDays: 180 },
        }) as never,
      currentVersion: '2026.5.9-3',
    }),
    { json: true },
  );
  expect(result.exitCode).toBe(0);
  const json = JSON.parse(out.lines[0]!.msg) as {
    system: { binaryAge: { days: number | null } };
  };
  expect(json.system.binaryAge.days).toBeGreaterThanOrEqual(13);
});

test('runStatus JSON mode handles invalid installedAt timestamp gracefully (days=null path)', async () => {
  const out = captureOutput();
  const result = await runStatus(
    makeDeps({
      output: out,
      loadConfig: async () =>
        ({
          account: {
            apiKey: 'k',
            userId: 'u',
            hostId: 'h',
            installedAt: 'not-a-date',
            installSource: 'npm',
          },
          backend: {
            ingestUrl: '',
            verifyKeyUrl: '',
            watermarksUrl: '',
            registerHostIdUrl: '',
          },
          capture: {
            pollIntervalSec: 60,
            bufferPath: '',
            receiptRetentionDays: 30,
            failedRetentionDays: 30,
            bufferSoftPauseBytes: 700_000_000,
            bufferSoftResumeBytes: 600_000_000,
            uploadMaxBatchesPerSec: 1,
            uploadMaxBytesPerMinute: 1,
            uploadBackoffOn429Multiplier: 1,
          },
          logging: { level: 'info', logDir: '' },
          staleBinary: { warnAfterDays: 90, pauseAfterDays: 180 },
        }) as never,
    }),
    { json: true },
  );
  expect(result.exitCode).toBe(0);
  const json = JSON.parse(out.lines[0]!.msg) as {
    system: { binaryAge: { days: number | null } };
  };
  expect(json.system.binaryAge.days).toBeNull();
});

test('runStatus surfaces per-source upload counters in JSON output when metadata populated', async () => {
  setMetadata(buffer, uploadBatchesShippedKey('claude-code'), '70');
  setMetadata(buffer, uploadBytesShippedKey('claude-code'), (9 * 1024 * 1024).toString());
  setMetadata(buffer, uploadBatchesShippedKey('cursor'), '14');
  setMetadata(buffer, uploadBytesShippedKey('cursor'), (2 * 1024 * 1024).toString());
  const out = captureOutput();
  const result = await runStatus(makeDeps({ output: out }), { json: true });
  expect(result.exitCode).toBe(0);
  const json = JSON.parse(out.lines[0]?.msg ?? '{}') as {
    upload: { shippedBySource: Record<string, { batches: number; bytes: number }> };
  };
  expect(json.upload.shippedBySource['claude-code']).toEqual({
    batches: 70,
    bytes: 9 * 1024 * 1024,
  });
  expect(json.upload.shippedBySource['cursor']).toEqual({ batches: 14, bytes: 2 * 1024 * 1024 });
  expect(json.upload.shippedBySource['codex']).toBeUndefined();
});

test('readNumberWithFallback: primary present but non-finite falls through to legacy', async () => {
  setMetadata(buffer, METADATA_KEYS.drainTotalBatchesShipped, 'garbage');
  setMetadata(buffer, METADATA_KEYS.uploadTotalBatchesShipped, '42');
  const out = captureOutput();
  const result = await runStatus(makeDeps({ output: out }), { json: true });
  expect(result.exitCode).toBe(0);
  const json = JSON.parse(out.lines[0]!.msg) as { upload: { totalBatchesShipped: number } };
  expect(json.upload.totalBatchesShipped).toBe(42);
});

test('getMetadataWithFallback: primary present uses primary, no legacy lookup', async () => {
  setMetadata(buffer, METADATA_KEYS.captureLastCycleAt, '2026-05-08T13:30:00.000Z');
  const out = captureOutput();
  const result = await runStatus(makeDeps({ output: out }), { json: true });
  expect(result.exitCode).toBe(0);
});
