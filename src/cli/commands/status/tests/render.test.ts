import { expect, test } from 'bun:test';

import { renderFullStatus } from 'cli/commands/status/render/render-full.ts';
import {
  renderCaptureSection,
  renderBufferSection,
  renderUploadSection,
  renderHistorySection,
  maskApiKey,
  renderHealthSection,
  renderLastUploadsSection,
  renderResyncNote,
} from 'cli/commands/status/render/render-sections.ts';
import type { RenderInputs } from 'cli/commands/status/render/render.types.ts';
import type { StatusCommandDeps, StatusSnapshot } from 'cli/commands/status/status.types.ts';
import type { GatewayConfig } from 'services/config';
import type { CountsBySource } from 'services/buffer';

const mockCfg: GatewayConfig = {
  account: {
    apiKey: 'my-api-key-12345678',
    userId: 'u_1',
    hostId: 'h_1',
    installedAt: '2026-05-01T00:00:00Z',
    installSource: 'github_release',
  },
  backend: {
    ingestUrl: 'http://localhost',
    verifyKeyUrl: 'http://localhost',
    watermarksUrl: 'http://localhost',
    registerHostIdUrl: 'http://localhost',
  },
  capture: {
    pollIntervalSec: 10,
    bufferPath: '/some/path',
    receiptRetentionDays: 1,
    failedRetentionDays: 2,
    bufferSoftPauseBytes: 100,
    bufferSoftResumeBytes: 50,
    uploadMaxBatchesPerSec: 10,
    uploadMaxBytesPerMinute: 1000,
    uploadBackoffOn429Multiplier: 1.5,
  },
  logging: { level: 'info', logDir: '/logs' },
  staleBinary: {
    warnAfterDays: 10,
    pauseAfterDays: 20,
  },
};

const emptySourceCounts = { pending: 0, pendingBytes: 0, failed: 0, failedBytes: 0, delivered: 0 };
const mockSourceCounts: CountsBySource = {
  'claude-code': emptySourceCounts,
  cursor: emptySourceCounts,
  codex: emptySourceCounts,
  'gemini-cli': emptySourceCounts,
  'claude-desktop': emptySourceCounts,
};

const mockSnapshot: StatusSnapshot = {
  profileName: 'prod',
  health: 'healthy',
  isDevMode: false,
  authFailed: false,
  authFailedReason: '',
  authFailedDetectedAt: '',
  authFailedRetryAttempts: 0,
  authFailedRetryMax: 0,
  authFailedRetryExhausted: false,
  bufferFull: false,
  bufferFullPendingBytes: null,
  bufferFullThreshold: null,
  sessionStopped: false,
  sessionStoppedSetAt: null,
  updateAvailable: null,
  hasRecentActivity: true,
  counts: { pending: 0, failed: 0, delivered: 0 },
  pendingBytes: 0,
  failedBytes: 0,
  quarantinedCount: 0,
  sourceCounts: mockSourceCounts,
  lastPruneAt: null,
  daemonState: null,
  captureCyclesTotal: 0,
  captureCyclesWithErrors: 0,
  captureLastCycleAt: null,
  drainLastCycleAt: null,
  drainCyclesTotal: 0,
  drainCyclesTotalDurationMs: 0,
  totalBatchesShipped: 0,
  totalBytesShipped: 0,
  capturedBytes: 0,
  uploadedBytes: 0,
  idempotentCount: 0,
  shippedBySource: {},
  lastSuccessAt: null,
  lastSuccessBatches: null,
  lastSuccessBytes: null,
  lastVersionCheckAt: null,
  latestKnownVersion: null,
  lastUploads: [],
  resyncCount: 0,
  lastResyncAt: null,
  runtime: { isRunning: false, pid: null, startedAt: null },
  cfg: mockCfg,
  now: new Date('2026-05-25T12:00:00Z'),
  history: null,
};

const baseInputs: RenderInputs = {
  summary: {
    level: 'ok',
    headline: 'Background service is running',
    hint: null,
  },
  snapshot: mockSnapshot,
  notConfigured: false,
  isDevMode: false,
  isLocalBuild: false,
  binaryPath: null,
  nowLocal: new Date('2026-05-25T12:00:00Z'),
  version: '2026.5.25',
};

const baseDeps: StatusCommandDeps = {
  output: {
    info: () => {},
    warn: () => {},
    error: () => {},
    success: () => {},
  },
  configPath: '/some/config.toml',
  configExists: () => Promise.resolve(true),
  bufferFullSentinelPath: '/some/BUFFER_FULL',
  authFailedSentinelPath: '/some/AUTH_FAILED',
  sessionStoppedSentinelPath: '/some/SESSION_STOPPED',
};

test('renderFullStatus cleanSummaryJargon cases', () => {
  const t1 = renderFullStatus(
    {
      ...baseInputs,
      summary: {
        level: 'ok',
        headline: 'Dev daemon active — running locally.',
        hint: 'Restart your dev daemon to resume.',
      },
    },
    baseDeps,
  );
  expect(t1).toContain('App is running locally.');
  expect(t1).toContain('Restart the app to resume.');

  const t2 = renderFullStatus(
    {
      ...baseInputs,
      summary: {
        level: 'warning',
        headline: 'Dev daemon is not running',
        hint: 'Reboot your machine or run `proxai-gateway start`',
      },
    },
    baseDeps,
  );
  expect(t2).toContain('App is not running.');
  expect(t2).toContain('Run `proxai-gateway start` to resume.');

  const t3 = renderFullStatus(
    {
      ...baseInputs,
      summary: {
        level: 'warning',
        headline: 'Dev daemon stopped',
        hint: 'Please register with launchd/systemd.',
      },
    },
    baseDeps,
  );
  expect(t3).toContain('App is stopped.');
  expect(t3).toContain('Run `proxai-gateway start` to enable auto-restart.');

  const t4 = renderFullStatus(
    {
      ...baseInputs,
      summary: {
        level: 'warning',
        headline: 'Buffer almost full',
        hint: 'background service problem',
      },
    },
    baseDeps,
  );
  expect(t4).toContain('System buffer is almost full');
  expect(t4).toContain('app problem');
});

test('renderFullStatus other headline and hint rewrites', () => {
  const t1 = renderFullStatus(
    {
      ...baseInputs,
      isLocalBuild: true,
      binaryPath: '/my/binary',
      summary: {
        level: 'ok',
        headline: 'Background service is running',
        hint: 'daemon terminal background service',
      },
    },
    baseDeps,
  );
  expect(t1).toContain('App is running.');
  expect(t1).toContain('terminal app');
  expect(t1).toContain('LOCAL BUILD');
});

test('renderFullStatus isLocalBuild and ingest url', () => {
  const t1 = renderFullStatus(
    {
      ...baseInputs,
      isLocalBuild: true,
      isDevMode: false,
      binaryPath: null,
    },
    baseDeps,
  );
  expect(t1).toContain('LOCAL BUILD');
  expect(t1).toContain('backend:');
});

test('renderFullStatus compact and dual profiles', () => {
  const tCompact = renderFullStatus(
    {
      ...baseInputs,
      compact: true,
    },
    baseDeps,
  );
  expect(tCompact).toContain('v2026.5.25');

  const tDual = renderFullStatus(
    {
      ...baseInputs,
      secondProfile: {
        ...baseInputs,
        isDevMode: true,
        summary: { level: 'ok', headline: 'Dev daemon is running', hint: null },
      },
    },
    baseDeps,
  );
  expect(tDual).toContain('[prod]');
  expect(tDual).toContain('[dev]');
});

test('render-sections renderCaptureSection', () => {
  const sEmpty = { ...mockSnapshot, daemonState: null };
  expect(renderCaptureSection(sEmpty).join('\n')).toContain('Capture');

  const sPopulated = {
    ...mockSnapshot,
    daemonState: {
      lastCycleStartedAt: '2026-05-25T12:00:00Z',
      lastCycleCompletedAt: '2026-05-25T12:01:00Z',
      lastCycleDurationMs: 60000,
      lastDrainAttempted: 1,
      lastDrainAccepted: 1,
      lastDrainRetriable: 0,
      lastDrainFatal: 0,
      lastDrainRecovered: 0,
      lastUploadError: null,
      lastConsecutiveRetriableBreak: false,
      lastSourceCaptures: {
        cursor: { filesProcessed: 5, capturedBatches: 2, capturedBytes: 100, errorsCount: 1 },
      },
    },
  };
  const r = renderCaptureSection(sPopulated).join('\n');
  expect(r).toContain('Cursor');
  expect(r).toContain('5 files scanned');
  expect(r).toContain('1 errors');
});

test('render-sections renderBufferSection sourceCounts and quarantined', () => {
  const s = {
    ...mockSnapshot,
    counts: { pending: 2, failed: 1, delivered: 10 },
    pendingBytes: 200,
    failedBytes: 100,
    quarantinedCount: 5,
    lastPruneAt: '2026-05-25T11:50:00Z',
    sourceCounts: {
      ...mockSourceCounts,
      'claude-code': { pending: 2, pendingBytes: 200, failed: 1, failedBytes: 100, delivered: 0 },
    },
  };
  const r = renderBufferSection(s).join('\n');
  expect(r).toContain('Claude Code');
  expect(r).toContain('Quarantined');
  expect(r).toContain('Last prune');
});

test('render-sections renderUploadSection error states and bysource', () => {
  const s = {
    ...mockSnapshot,
    drainCyclesTotal: 1,
    totalBatchesShipped: 5,
    lastSuccessAt: '2026-05-25T11:59:00Z',
    lastSuccessBatches: 2,
    lastSuccessBytes: 200,
    daemonState: {
      lastCycleStartedAt: '2026-05-25T12:00:00Z',
      lastCycleCompletedAt: '2026-05-25T12:01:00Z',
      lastCycleDurationMs: 60000,
      lastDrainAttempted: 1,
      lastDrainAccepted: 0,
      lastDrainRetriable: 1,
      lastDrainFatal: 0,
      lastDrainRecovered: 0,
      lastUploadError: 'boom error',
      lastConsecutiveRetriableBreak: true,
      lastSourceCaptures: {},
    },
    shippedBySource: {
      cursor: { batches: 5, bytes: 500 },
    },
  };
  const r = renderUploadSection(s).join('\n');
  expect(r).toContain('Upload');
  expect(r).toContain('boom error');
  expect(r).toContain('Cursor');
  expect(r).toContain('Last success');
  expect(r).toContain('2 batches');
  expect(r).toContain('200 B shipped');
});

test('render-sections maskApiKey', () => {
  expect(maskApiKey(null)).toBe('none');
  expect(maskApiKey('1234')).toBe('*****');
  expect(maskApiKey('1234567890')).toBe('1234*****7890');
});

test('render-sections renderHealthSection combinations', () => {
  const s1 = {
    ...mockSnapshot,
    runtime: {
      isRunning: true,
      pid: 1234,
      startedAt: new Date(mockSnapshot.now.getTime() - 60000),
    },
    cfg: {
      ...mockCfg,
      account: {
        ...mockCfg.account,
        installedAt: 'invalid-date',
      },
    },
  };
  const r1 = renderHealthSection({
    s: s1,
    currentVersion: '2026.5.25',
    inferredAlive: false,
    isDevLike: true,
    isLocalBuild: false,
  }).join('\n');
  expect(r1).toContain('running');
  expect(r1).toContain('uptime 1 min');
  expect(r1).toContain('PID');

  const s2 = {
    ...mockSnapshot,
    runtime: { isRunning: false, pid: null, startedAt: null },
    lastVersionCheckAt: '2026-05-25T11:00:00Z',
    latestKnownVersion: '2026.5.25',
    cfg: {
      ...mockCfg,
      account: {
        ...mockCfg.account,
        installedAt: null as unknown as string,
      },
    },
  };
  const r2 = renderHealthSection({
    s: s2,
    currentVersion: '2026.5.25',
    inferredAlive: true,
    isDevLike: false,
    isLocalBuild: true,
  }).join('\n');
  expect(r2).toContain('running (local build)');
  expect(r2).toContain('up to date');

  const s3 = {
    ...mockSnapshot,
    latestKnownVersion: '2026.5.26',
    updateAvailable: { latestVersion: '2026.5.26', currentVersion: '2026.5.25' },
    cfg: {
      ...mockCfg,
      account: {
        ...mockCfg.account,
        installedAt: new Date(mockSnapshot.now.getTime() - 15 * 86400000).toISOString(),
      },
    },
  };
  const r3 = renderHealthSection({
    s: s3,
    currentVersion: '2026.5.25',
    inferredAlive: true,
    isDevLike: true,
    isLocalBuild: false,
  }).join('\n');
  expect(r3).toContain('running (dev mode)');
  expect(r3).toContain('update pending');
  expect(r3).toContain('15 days');

  const s4 = {
    ...mockSnapshot,
    latestKnownVersion: '2026.5.26',
    cfg: {
      ...mockCfg,
      account: {
        ...mockCfg.account,
        installedAt: new Date(mockSnapshot.now.getTime() - 25 * 86400000).toISOString(),
      },
    },
  };
  const r4 = renderHealthSection({
    s: s4,
    currentVersion: '2026.5.25',
    inferredAlive: false,
    isDevLike: false,
    isLocalBuild: false,
  }).join('\n');
  expect(r4).toContain('queued for next cycle');
  expect(r4).toContain('25 days');

  const s5 = {
    ...mockSnapshot,
    authFailed: true,
    bufferFull: true,
    sessionStopped: true,
    updateAvailable: { latestVersion: '2026.5.26', currentVersion: '2026.5.25' },
  };
  const r5 = renderHealthSection({
    s: s5,
    currentVersion: '2026.5.25',
    inferredAlive: false,
    isDevLike: false,
    isLocalBuild: false,
  }).join('\n');
  expect(r5).toContain('authentication failed, buffer full, stopped, update available');

  const s6 = {
    ...mockSnapshot,
    cfg: {
      ...mockCfg,
      account: {
        ...mockCfg.account,
        installedAt: new Date(mockSnapshot.now.getTime() - 35 * 86400000).toISOString(),
      },
    },
  };
  const r6 = renderHealthSection({
    s: s6,
    currentVersion: '2026.5.25',
    inferredAlive: false,
    isDevLike: false,
    isLocalBuild: false,
  }).join('\n');
  expect(r6).toContain('35 days');

  const s7 = {
    ...mockSnapshot,
    cfg: {
      ...mockCfg,
      account: {
        ...mockCfg.account,
        installedAt: new Date(mockSnapshot.now.getTime() - 65 * 86400000).toISOString(),
      },
    },
  };
  const r7 = renderHealthSection({
    s: s7,
    currentVersion: '2026.5.25',
    inferredAlive: false,
    isDevLike: false,
    isLocalBuild: false,
  }).join('\n');
  expect(r7).toContain('65 days');

  const s8 = {
    ...mockSnapshot,
    cfg: {
      ...mockCfg,
      account: {
        ...mockCfg.account,
        installedAt: new Date(mockSnapshot.now.getTime() + 5 * 86400000).toISOString(),
      },
    },
  };
  const r8 = renderHealthSection({
    s: s8,
    currentVersion: '2026.5.25',
    inferredAlive: false,
    isDevLike: false,
    isLocalBuild: false,
  }).join('\n');
  expect(r8).toContain('0 days');

  const s9 = {
    ...mockSnapshot,
    cfg: null as unknown as GatewayConfig,
  };
  const r9 = renderHealthSection({
    s: s9,
    currentVersion: '2026.5.25',
    inferredAlive: false,
    isDevLike: false,
    isLocalBuild: false,
  }).join('\n');
  expect(r9).toContain('unknown');

  const s10 = {
    ...mockSnapshot,
    runtime: { isRunning: false, pid: null, startedAt: null },
  };
  const r10 = renderHealthSection({
    s: s10,
    currentVersion: '2026.5.25',
    inferredAlive: true,
    isDevLike: false,
    isLocalBuild: false,
  }).join('\n');
  expect(r10).toContain('running');
  expect(r10).not.toContain('dev mode');
  expect(r10).not.toContain('local build');

  const s11 = {
    ...mockSnapshot,
    runtime: {
      isRunning: true,
      pid: 1234,
      startedAt: new Date(mockSnapshot.now.getTime() + 60000),
    },
  };
  const r11 = renderHealthSection({
    s: s11,
    currentVersion: '2026.5.25',
    inferredAlive: false,
    isDevLike: false,
    isLocalBuild: false,
  }).join('\n');
  expect(r11).toContain('running');
  expect(r11).not.toContain('uptime');
});

test('render-sections renderLastUploadsSection and renderResyncNote', () => {
  const s = {
    ...mockSnapshot,
    capturedBytes: 100,
    counts: { pending: 1, failed: 0, delivered: 2 },
    idempotentCount: 1,
    resyncCount: 3,
    lastResyncAt: '2026-05-25T11:59:00Z',
    lastUploads: [
      {
        rowid: 1,
        sourceApp: 'cursor' as const,
        shippedBytes: 50,
        userPrompt:
          'test prompt snippet long snippet text goes here and it is extremely long indeed so that it exceeds eighty characters easily',
        deliveredAt: '2026-05-25T11:59:30Z',
        userPromptAddedAt: '2026-05-25T11:59:20Z',
        idempotentOnServer: false,
      },
      {
        rowid: 2,
        sourceApp: 'cursor' as const,
        shippedBytes: null,
        userPrompt: null,
        deliveredAt: '2026-05-25T11:59:40Z',
        userPromptAddedAt: null,
        idempotentOnServer: false,
      },
      {
        rowid: 3,
        sourceApp: 'cursor' as const,
        shippedBytes: 10,
        userPrompt: 'short prompt',
        deliveredAt: '2026-05-25T11:59:50Z',
        userPromptAddedAt: '2026-05-25T11:59:45Z',
        idempotentOnServer: false,
      },
    ],
  };

  const rUploads = renderLastUploadsSection(s).join('\n');
  expect(rUploads).toContain('Summary');
  expect(rUploads).toContain('100 B captured');
  expect(rUploads).toContain('2 uploaded');
  expect(rUploads).toContain('1 pending');
  expect(rUploads).toContain('1 re-sent');
  expect(rUploads).toContain('cursor');
  expect(rUploads).toContain('extremely long indeed …');
  expect(rUploads).toContain('short prompt');

  const rResync = renderResyncNote(s).join('\n');
  expect(rResync).toContain('Re-synced with server: 3 times');

  const rResyncNull = renderResyncNote({ ...s, lastResyncAt: null }).join('\n');
  expect(rResyncNull).toContain('Re-synced with server: 3 times');
});

test('render-sections renderHistorySection', () => {
  const s = {
    ...mockSnapshot,
    history: {
      totalBytesCaptured: 1000,
      totalBytesSent: 900,
      totalRecordsCaptured: 50,
      totalRecordsSent: 45,
      conversationsCaptured: {
        cursor: 10,
        'claude-code': 5,
        codex: 0,
        'gemini-cli': 0,
        'claude-desktop': 0,
      },
    },
  };
  const r = renderHistorySection(s).join('\n');
  expect(r).toContain('History');
  expect(r).toContain('1000 B');
  expect(r).toContain('Cursor');
  expect(r).toContain('10');
});

test('renderHealthSection: shows the trial count while auth recovery is retrying', () => {
  const s = {
    ...mockSnapshot,
    authFailed: true,
    authFailedRetryAttempts: 3,
    authFailedRetryMax: 16,
  };
  const out = renderHealthSection({
    s,
    currentVersion: '2026.5.25',
    inferredAlive: true,
    isDevLike: false,
    isLocalBuild: false,
  }).join('\n');
  expect(out).toContain('retrying 3/16');
});

test('renderHealthSection: shows gave-up label once auth recovery is exhausted', () => {
  const s = {
    ...mockSnapshot,
    authFailed: true,
    authFailedRetryAttempts: 16,
    authFailedRetryMax: 16,
    authFailedRetryExhausted: true,
  };
  const out = renderHealthSection({
    s,
    currentVersion: '2026.5.25',
    inferredAlive: true,
    isDevLike: false,
    isLocalBuild: false,
  }).join('\n');
  expect(out).toContain('gave up after 16 retries');
});

test('renderHealthSection: terse dev gave-up label when exhausted', () => {
  const s = {
    ...mockSnapshot,
    authFailed: true,
    authFailedRetryMax: 16,
    authFailedRetryExhausted: true,
  };
  const out = renderHealthSection({
    s,
    currentVersion: '2026.5.25',
    inferredAlive: true,
    isDevLike: true,
    isLocalBuild: false,
  }).join('\n');
  expect(out).toContain('gave up 16/16');
});
