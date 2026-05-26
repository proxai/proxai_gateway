import { expect, test } from 'bun:test';
import { renderVerbose } from 'cli/commands/status/render/render-verbose.ts';
import type { RenderInputs } from 'cli/commands/status/render/render.types.ts';
import type { StatusSnapshot } from 'cli/commands/status/status.types.ts';

const NOW = new Date('2026-05-25T12:34:56Z');

function sampleSnapshot(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    health: 'healthy',
    isDevMode: false,
    paused: false,
    pausedReason: '',
    authFailed: false,
    authFailedReason: '',
    authFailedDetectedAt: '',
    bufferFull: false,
    bufferFullPendingBytes: null,
    bufferFullThreshold: null,
    sessionStopped: false,
    sessionStoppedSetAt: null,
    updateAvailable: null,
    hasRecentActivity: true,
    counts: { pending: 0, failed: 0, delivered: 100 },
    pendingBytes: 0,
    failedBytes: 0,
    quarantinedCount: 0,
    sourceCounts: {
      'claude-code': { pending: 0, pendingBytes: 0, failed: 0, failedBytes: 0, delivered: 0 },
      cursor: { pending: 0, pendingBytes: 0, failed: 0, failedBytes: 0, delivered: 0 },
      codex: { pending: 0, pendingBytes: 0, failed: 0, failedBytes: 0, delivered: 0 },
      'gemini-cli': { pending: 0, pendingBytes: 0, failed: 0, failedBytes: 0, delivered: 0 },
    },
    lastPruneAt: null,
    daemonState: null,
    captureCyclesTotal: 10,
    captureCyclesWithErrors: 1,
    captureLastCycleAt: '2026-05-25T12:30:00Z',
    drainLastCycleAt: '2026-05-25T12:30:30Z',
    drainCyclesTotal: 5,
    drainCyclesTotalDurationMs: 0,
    totalBatchesShipped: 100,
    totalBytesShipped: 1_000_000,
    shippedBySource: { 'claude-code': { batches: 50, bytes: 500_000 } },
    lastSuccessAt: '2026-05-25T12:33:00Z',
    lastSuccessBatches: 5,
    lastSuccessBytes: 50_000,
    lastVersionCheckAt: '2026-05-25T10:00:00Z',
    latestKnownVersion: '2026.5.25',
    runtime: { isRunning: true, pid: 12345, startedAt: new Date('2026-05-25T08:00:00Z') },
    cfg: null,
    now: NOW,
    history: null,
    ...overrides,
  };
}

function renderInputs(overrides: Partial<RenderInputs> = {}): RenderInputs {
  return {
    summary: {
      level: 'ok',
      headline: 'Account configured. Background service is running.',
      hint: null,
    },
    snapshot: sampleSnapshot(),
    notConfigured: false,
    isDevMode: false,
    nowLocal: NOW,
    version: '2026.5.25',
    ...overrides,
  };
}

test('renderVerbose includes everything renderBasic does', () => {
  const out = renderVerbose(renderInputs());
  expect(out).toContain('proxai-gateway');
  expect(out).toContain('Uploaded:');
});

test('renderVerbose adds a by-source section', () => {
  const out = renderVerbose(renderInputs());
  expect(out).toContain('By source');
  expect(out).toContain('claude-code');
});

test('renderVerbose shows "no source activity yet" when both shipped and pending are empty', () => {
  const out = renderVerbose(
    renderInputs({
      snapshot: sampleSnapshot({
        shippedBySource: {},
        sourceCounts: {
          'claude-code': { pending: 0, pendingBytes: 0, failed: 0, failedBytes: 0, delivered: 0 },
          cursor: { pending: 0, pendingBytes: 0, failed: 0, failedBytes: 0, delivered: 0 },
          codex: { pending: 0, pendingBytes: 0, failed: 0, failedBytes: 0, delivered: 0 },
          'gemini-cli': { pending: 0, pendingBytes: 0, failed: 0, failedBytes: 0, delivered: 0 },
        },
      }),
    }),
  );
  expect(out).toContain('No source activity yet');
});

test('renderVerbose shows a recent activity section with last upload time', () => {
  const out = renderVerbose(renderInputs());
  expect(out).toContain('Recent activity');
  expect(out).toContain('Last upload:');
});

test('renderVerbose reports "never" when there is no last upload', () => {
  const out = renderVerbose(renderInputs({ snapshot: sampleSnapshot({ lastSuccessAt: null }) }));
  expect(out).toContain('never');
});

test('renderVerbose surfaces the last upload error in red when daemon state has one', () => {
  const out = renderVerbose(
    renderInputs({
      snapshot: sampleSnapshot({
        daemonState: {
          lastCycleStartedAt: null,
          lastCycleCompletedAt: null,
          lastCycleDurationMs: null,
          lastDrainAttempted: 0,
          lastDrainAccepted: 0,
          lastDrainRetriable: 0,
          lastDrainFatal: 0,
          lastDrainRecovered: 0,
          lastUploadError: 'server returned 500',
          lastConsecutiveRetriableBreak: null,
          lastSourceCaptures: {},
        },
      }),
    }),
  );
  expect(out).toContain('Last error:');
  expect(out).toContain('server returned 500');
});

test('renderVerbose shows a signals section listing each sentinel state', () => {
  const out = renderVerbose(renderInputs());
  expect(out).toContain('Signals');
  expect(out).toContain('Auth failure:');
  expect(out).toContain('Paused:');
  expect(out).toContain('Buffer pressure:');
});

test('renderVerbose marks active sentinels with reasons', () => {
  const out = renderVerbose(
    renderInputs({
      snapshot: sampleSnapshot({ paused: true, pausedReason: 'maintenance' }),
    }),
  );
  expect(out).toContain('active');
  expect(out).toContain('maintenance');
});

test('renderVerbose computes buffer pressure percentage when threshold known', () => {
  const out = renderVerbose(
    renderInputs({
      snapshot: sampleSnapshot({
        bufferFull: true,
        bufferFullPendingBytes: 39_000_000_000,
        bufferFullThreshold: 50_000_000_000,
      }),
    }),
  );
  expect(out).toContain('78%');
});

test('renderVerbose falls back to "full" when buffer threshold is unknown', () => {
  const out = renderVerbose(
    renderInputs({
      snapshot: sampleSnapshot({
        bufferFull: true,
        bufferFullPendingBytes: null,
        bufferFullThreshold: null,
      }),
    }),
  );
  expect(out).toContain('full');
});

test('renderVerbose surfaces an available update with current version', () => {
  const out = renderVerbose(
    renderInputs({
      snapshot: sampleSnapshot({
        updateAvailable: { latestVersion: '2026.6.1', currentVersion: '2026.5.25' },
      }),
    }),
  );
  expect(out).toContain('Update available:');
  expect(out).toContain('2026.6.1');
  expect(out).toContain('2026.5.25');
});

test('renderVerbose shows the runtime section with running label and PID', () => {
  const out = renderVerbose(renderInputs());
  expect(out).toContain('Runtime');
  expect(out).toContain('running');
  expect(out).toContain('12,345');
});

test('renderVerbose labels stopped runtime as stopped', () => {
  const out = renderVerbose(
    renderInputs({
      snapshot: sampleSnapshot({
        runtime: { isRunning: false, pid: null, startedAt: null },
      }),
    }),
  );
  expect(out).toContain('stopped');
});

test('renderVerbose returns just the basic render when snapshot is null', () => {
  const out = renderVerbose(renderInputs({ snapshot: null }));
  expect(out).toContain('proxai-gateway');
  expect(out).not.toContain('By source');
});
