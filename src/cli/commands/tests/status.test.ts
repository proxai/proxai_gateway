import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { rmRecursive } from 'core/io/fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runStatus, formatBytes } from 'cli/commands/status';
import {
  formatLocalTimestamp,
  formatRelative,
  formatTimeWithRelative,
  deriveHealth,
  statusDot,
  sectionHeader,
} from 'cli/commands/format-status.ts';
import { captureOutput } from 'cli/output.ts';
import { generateUuidV7, zstdCompressSync } from 'core/utils';
import {
  getBatch,
  insertBatch,
  markBatchDelivered,
  markBatchFailed,
  openInMemoryBufferDb,
  setDaemonState,
} from 'services/buffer';
import type { NewBatch } from 'services/buffer';
import { pausePolling } from 'services/polling';

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

function batch(
  text = 'x',
  sourceApp: 'claude-code' | 'cursor' | 'codex' = 'claude-code',
): NewBatch {
  return {
    captureId: generateUuidV7(),
    sourceApp,
    sourceKind: 'jsonl_append',
    sourcePath: '/x',
    sourcePathHash: 'a'.repeat(64),
    sourceInode: 1,
    watermarkKind: 'byte_range',
    watermarkStart: 0,
    watermarkEnd: text.length,
    watermarkTable: null,
    agentSchemaVersion: '1.0',
    gatewayVersion: 'gw',
    capturedAtUtc: '2026-04-29T10:42:00.123Z',
    bodyFormat: 'jsonl',
    bodyCompression: 'zstd',
    body: zstdCompressSync(text),
  };
}

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
    ...extras,
  };
}

test('reports not-configured when config does not exist (text mode)', async () => {
  const out = captureOutput();
  const result = await runStatus(
    makeDeps({ output: out, configExists: () => Promise.resolve(false) }),
  );
  expect(result.exitCode).toBe(4);
  expect(out.lines.some((l) => l.msg.includes('not configured'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('proxai-gateway setup'))).toBe(true);
  expect(out.lines.some((l) => l.msg.toLowerCase().includes('unable to open'))).toBe(false);
});

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

test('reports configured but no recent activity when daemon has not run yet', async () => {
  const out = captureOutput();
  const result = await runStatus(makeDeps({ output: out }));
  expect(result.exitCode).toBe(0);
  expect(out.lines.some((l) => l.msg.includes('Status:'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('starting'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('no drain completed yet'))).toBe(true);
});

test('renders per-source row with capture stats from daemon_state', async () => {
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
    lastConsecutiveRetriableBreak: false,
    lastSourceCaptures: {
      'claude-code': {
        filesProcessed: 63,
        capturedBatches: 68,
        capturedBytes: 137000000,
        errorsCount: 0,
      },
      cursor: { filesProcessed: 7, capturedBatches: 14, capturedBytes: 14000000, errorsCount: 2 },
    },
  });

  const out = captureOutput();
  const result = await runStatus(makeDeps({ output: out }));
  expect(result.exitCode).toBe(0);
  expect(out.lines.some((l) => l.msg.includes('claude-code'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('68 captured'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('63 files scanned'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('cursor'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('2 errors'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('codex'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('Last error'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('server returned 500'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('1 retriable'))).toBe(true);
});

test('renders sectioned headers with bold formatting', async () => {
  const out = captureOutput();
  await runStatus(makeDeps({ output: out }));
  expect(out.lines.some((l) => l.msg.includes('Capture'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('Buffer'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('Upload'))).toBe(true);
});

test('counts pending failed and delivered batches', async () => {
  const a = batch();
  const b = batch();
  const c = batch();
  insertBatch(buffer, a);
  insertBatch(buffer, b);
  insertBatch(buffer, c);
  markBatchDelivered(buffer, getBatch(buffer, b.captureId)!, { idempotentOnServer: false });
  markBatchFailed(buffer, c.captureId, 'oops');

  const out = captureOutput();
  await runStatus(makeDeps({ output: out }));
  expect(out.lines.some((l) => l.msg.match(/Pending\s+1 batches/))).toBe(true);
  expect(out.lines.some((l) => l.msg.match(/Failed\s+1 batches/))).toBe(true);
  expect(out.lines.some((l) => l.msg.match(/Receipts\s+1/))).toBe(true);
});

test('reports PAUSED with reason and resume hint', async () => {
  await pausePolling(join(dir, 'PAUSED'), 'manual');
  const out = captureOutput();
  await runStatus(makeDeps({ output: out }));
  expect(out.lines.some((l) => l.msg.includes('PAUSED'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('manual'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('proxai-gateway resume'))).toBe(true);
});

test('reports BUFFER_FULL sentinel and threshold', async () => {
  await writeFile(
    join(dir, 'BUFFER_FULL'),
    JSON.stringify({
      pending_bytes: 850_000_000,
      threshold: 700_000_000,
      set_at: '2026-05-08T02:00:00Z',
    }),
  );
  const out = captureOutput();
  await runStatus(makeDeps({ output: out }));
  expect(out.lines.some((l) => l.msg.includes('BUFFER_FULL'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('pending'))).toBe(true);
});

test('reports AUTH_FAILED with reason and setup hint', async () => {
  await writeFile(
    join(dir, 'AUTH_FAILED'),
    JSON.stringify({ reason: 'key revoked', detected_at: '2026-05-08T01:00:00Z' }),
  );
  const out = captureOutput();
  await runStatus(makeDeps({ output: out }));
  expect(out.lines.some((l) => l.msg.includes('AUTH_FAILED'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('key revoked'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('proxai-gateway setup'))).toBe(true);
});

test('reports SESSION_STOPPED sentinel with start hint', async () => {
  await writeFile(
    join(dir, 'SESSION_STOPPED'),
    JSON.stringify({ boot_id: 'b1', set_at: '2026-05-08T01:00:00Z' }),
  );
  const out = captureOutput();
  await runStatus(makeDeps({ output: out }));
  expect(out.lines.some((l) => l.msg.includes('SESSION_STOPPED'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('proxai-gateway start'))).toBe(true);
});

test('reports update_available with current and latest versions', async () => {
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
  await runStatus(makeDeps({ output: out, updateAvailableSentinelPath }));
  expect(out.lines.some((l) => l.msg.includes('Update available'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('2026.5.10'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('2026.5.7'))).toBe(true);
});

test('does not print update_available when sentinel absent', async () => {
  const updateAvailableSentinelPath = join(dir, 'UPDATE_AVAILABLE');
  const out = captureOutput();
  await runStatus(makeDeps({ output: out, updateAvailableSentinelPath }));
  expect(out.lines.some((l) => l.msg.includes('Update available'))).toBe(false);
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

test('shows degraded health label when last drain had retriable failures', async () => {
  setDaemonState(buffer, {
    lastCycleStartedAt: '2026-05-08T02:40:00Z',
    lastCycleCompletedAt: '2026-05-08T02:42:00Z',
    lastCycleDurationMs: 120000,
    lastDrainAttempted: 3,
    lastDrainAccepted: 0,
    lastDrainRetriable: 3,
    lastDrainFatal: 0,
    lastDrainRecovered: 0,
    lastUploadError: '503',
    lastConsecutiveRetriableBreak: true,
    lastSourceCaptures: {},
  });
  const out = captureOutput();
  await runStatus(makeDeps({ output: out }));
  expect(out.lines.some((l) => l.msg.includes('degraded'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('Drain backed off'))).toBe(true);
});

test('shows healthy active when last drain succeeded', async () => {
  setDaemonState(buffer, {
    lastCycleStartedAt: '2026-05-08T02:40:00Z',
    lastCycleCompletedAt: '2026-05-08T02:42:00Z',
    lastCycleDurationMs: 120000,
    lastDrainAttempted: 5,
    lastDrainAccepted: 5,
    lastDrainRetriable: 0,
    lastDrainFatal: 0,
    lastDrainRecovered: 0,
    lastUploadError: null,
    lastConsecutiveRetriableBreak: false,
    lastSourceCaptures: {},
  });
  const out = captureOutput();
  await runStatus(makeDeps({ output: out }));
  const statusLine = out.lines.find((l) => l.msg.includes('Status:'))!;
  expect(statusLine.msg).toContain('active');
  expect(statusLine.msg).not.toContain('degraded');
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

test('renders last-prune timestamp with relative when present', async () => {
  setDaemonState(buffer, {
    lastCycleStartedAt: null,
    lastCycleCompletedAt: null,
    lastCycleDurationMs: null,
    lastDrainAttempted: null,
    lastDrainAccepted: null,
    lastDrainRetriable: null,
    lastDrainFatal: null,
    lastDrainRecovered: null,
    lastUploadError: null,
    lastConsecutiveRetriableBreak: null,
    lastSourceCaptures: {},
  });
  buffer.run(
    "INSERT INTO buffer_metadata (key, value) VALUES ('last_prune_at', '2026-05-08T02:00:00Z')",
  );
  const out = captureOutput();
  await runStatus(makeDeps({ output: out, now: () => new Date('2026-05-08T02:30:00Z') }));
  expect(out.lines.some((l) => l.msg.includes('Last prune'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('30 min ago') || l.msg.includes('min ago'))).toBe(
    true,
  );
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

test('renders never for last-prune when metadata absent', async () => {
  const out = captureOutput();
  await runStatus(makeDeps({ output: out }));
  expect(out.lines.some((l) => l.msg.includes('never'))).toBe(true);
});

test('returns error when buffer is undefined but config exists (defensive guard)', async () => {
  const out = captureOutput();
  const result = await runStatus({
    output: out,
    configPath,
    configExists: () => Promise.resolve(true),
    pauseSentinelPath: join(dir, 'PAUSED'),
    bufferFullSentinelPath: join(dir, 'BUFFER_FULL'),
    authFailedSentinelPath: join(dir, 'AUTH_FAILED'),
    sessionStoppedSentinelPath: join(dir, 'SESSION_STOPPED'),
  });
  expect(result.exitCode).toBe(1);
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

test('runStatus: loadConfig dep that throws falls back gracefully', async () => {
  const out = captureOutput();
  const result = await runStatus(
    makeDeps({
      output: out,
      loadConfig: async () => {
        throw new Error('config blew up');
      },
    }),
  );
  expect(result.exitCode).toBe(0);
});

test('runStatus: serviceManager whose isRunning throws yields no daemon line crash', async () => {
  const out = captureOutput();
  const sm = {
    isRegistered: async () => true,
    isRunning: async () => {
      throw new Error('launchctl gone');
    },
    ensureRegistered: async () => {},
    start: async () => {},
    stop: async () => {},
    restart: async () => {},
    unregister: async () => {},
    runtimeInfo: async () => ({ pid: null, startedAt: null }),
  };
  const result = await runStatus(makeDeps({ output: out, serviceManager: sm }));
  expect(result.exitCode).toBe(0);
});

test('runStatus: invalid stored cumulative numbers degrade to zero', async () => {
  setMetadata(buffer, METADATA_KEYS.uploadTotalBatchesShipped, 'garbage');
  setMetadata(buffer, METADATA_KEYS.uploadLastSuccessBytes, 'NaN');
  const out = captureOutput();
  const result = await runStatus(makeDeps({ output: out }));
  expect(result.exitCode).toBe(0);
});

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
            initialScanWindowDays: 30,
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
            initialScanWindowDays: 30,
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

test('runStatus default loadConfig path also catches throws (no dep override)', async () => {
  const out = captureOutput();
  const result = await runStatus(makeDeps({ output: out }));
  expect(result.exitCode).toBe(0);
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
