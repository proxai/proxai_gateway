import { expect, test } from 'bun:test';
import { renderBasic } from 'cli/commands/status/render/render-basic.ts';
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
    counts: { pending: 23, failed: 0, delivered: 1234 },
    pendingBytes: 456_000,
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
    captureCyclesTotal: 5,
    captureCyclesWithErrors: 0,
    captureLastCycleAt: null,
    drainLastCycleAt: null,
    drainCyclesTotal: 12,
    drainCyclesTotalDurationMs: 0,
    totalBatchesShipped: 1234,
    totalBytesShipped: 12_400_000,
    shippedBySource: {},
    lastSuccessAt: null,
    lastSuccessBatches: null,
    lastSuccessBytes: null,
    lastVersionCheckAt: null,
    latestKnownVersion: null,
    runtime: { isRunning: true, pid: null, startedAt: null },
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

test('renderBasic includes the header with name, version, and timestamp', () => {
  const out = renderBasic(renderInputs());
  expect(out).toContain('proxai-gateway');
  expect(out).toContain('v2026.5.25');
  expect(out).toContain('2026-05-25');
});

test('renderBasic includes the unified status headline', () => {
  const out = renderBasic(renderInputs());
  expect(out).toContain('Account configured');
});

test('renderBasic includes the uploaded and pending totals', () => {
  const out = renderBasic(renderInputs());
  expect(out).toContain('Uploaded:');
  expect(out).toContain('Pending:');
  expect(out).toContain('1,234');
  expect(out).toContain('23');
});

test('renderBasic prints the hint when one is provided', () => {
  const out = renderBasic(
    renderInputs({
      summary: { level: 'warning', headline: 'Daemon paused', hint: 'Run resume to continue.' },
    }),
  );
  expect(out).toContain('Run resume to continue.');
});

test('renderBasic includes a quit instruction', () => {
  const out = renderBasic(renderInputs());
  expect(out).toContain('Press q');
});

test('renderBasic marks dev mode in the header when isDevMode is true', () => {
  const out = renderBasic(renderInputs({ isDevMode: true }));
  expect(out).toContain('dev mode');
});

test('renderBasic shows a failed-sessions line when counts.failed > 0', () => {
  const out = renderBasic(
    renderInputs({ snapshot: sampleSnapshot({ counts: { pending: 0, failed: 7, delivered: 0 } }) }),
  );
  expect(out).toContain('Failed:');
  expect(out).toContain('7');
});

test('renderBasic omits totals when snapshot is null', () => {
  const out = renderBasic(renderInputs({ snapshot: null }));
  expect(out).not.toContain('Uploaded:');
  expect(out).not.toContain('Pending:');
});

test('renderBasic header omits version when none is provided', () => {
  const out = renderBasic(renderInputs({ version: null }));
  expect(out).not.toContain('v2026');
});
