import { expect, test } from 'bun:test';

import {
  formatDuration,
  formatPercent,
  renderBufferSection,
  renderCaptureCyclesLine,
  renderCaptureRow,
  renderHealthSection,
  renderUploadSection,
} from 'cli/commands/format-status.ts';
import { DEFAULT_STALE_PAUSE_DAYS, DEFAULT_STALE_WARN_DAYS } from 'services/config';

const NOW = new Date('2026-05-08T13:32:17Z');

test('formatDuration covers ms / s / min / h / d brackets', () => {
  expect(formatDuration(0)).toBe('0 ms');
  expect(formatDuration(NaN)).toBe('0 ms');
  expect(formatDuration(-5)).toBe('0 ms');
  expect(formatDuration(421)).toBe('421 ms');
  expect(formatDuration(2_500)).toBe('2 s');
  expect(formatDuration(120_000)).toBe('2 min');
  expect(formatDuration(3 * 3600_000 + 14 * 60_000)).toBe('3h 14m');
  expect(formatDuration(2 * 86_400_000 + 5 * 3600_000)).toBe('2d 5h');
});

test('formatPercent handles invalid total, sub-1% floor, and round', () => {
  expect(formatPercent(0, 0)).toBe('0%');
  expect(formatPercent(0, 100)).toBe('0%');
  expect(formatPercent(1, 100_000)).toBe('<1%');
  expect(formatPercent(50, 100)).toBe('50%');
  expect(formatPercent(NaN, 100)).toBe('0%');
});

test('renderCaptureRow formats source, counts, and zero-error column', () => {
  const line = renderCaptureRow({
    name: 'cursor',
    capturedBatches: 3,
    filesProcessed: 7,
    errorsCount: 0,
  });
  expect(line).toContain('Cursor');
  expect(line).toContain('3 captured');
  expect(line).toContain('7 files scanned');
  expect(line).toContain('0 errors');
});

test('renderCaptureRow highlights non-zero errors', () => {
  const line = renderCaptureRow({
    name: 'codex',
    capturedBatches: 0,
    filesProcessed: 1,
    errorsCount: 2,
  });
  expect(line).toContain('2 errors');
});

test('renderBufferSection emits Pending/Failed/Receipts/Pressure/Last prune lines', () => {
  const lines = renderBufferSection({
    pendingCount: 0,
    pendingBytes: 0,
    failedCount: 0,
    failedBytes: 0,
    receiptsCount: 86,
    pressurePendingBytes: 0,
    pressureSoftPauseBytes: 700 * 1024 * 1024,
    lastPruneAt: '2026-05-08T13:28:50Z',
    bySource: null,
    now: NOW,
  });
  const joined = lines.join('\n');
  expect(joined).toContain('Buffer');
  expect(joined).toContain('Pending');
  expect(joined).toContain('Failed');
  expect(joined).toContain('Receipts');
  expect(joined).toContain('86');
  expect(joined).toContain('records');
  expect(joined).toContain('Pressure');
  expect(joined).toContain('soft-pause threshold');
  expect(joined).toContain('Last prune');
});

test('renderBufferSection prints Quarantined line when quarantinedCount > 0', () => {
  const lines = renderBufferSection({
    pendingCount: 0,
    pendingBytes: 0,
    failedCount: 0,
    failedBytes: 0,
    receiptsCount: 0,
    quarantinedCount: 3,
    pressurePendingBytes: 0,
    pressureSoftPauseBytes: 1024,
    lastPruneAt: null,
    bySource: null,
    now: NOW,
  });
  const joined = lines.join('\n');
  expect(joined).toContain('Quarantined');
  expect(joined).toContain('3');
});

test('renderBufferSection omits Quarantined line when count is zero', () => {
  const lines = renderBufferSection({
    pendingCount: 0,
    pendingBytes: 0,
    failedCount: 0,
    failedBytes: 0,
    receiptsCount: 0,
    quarantinedCount: 0,
    pressurePendingBytes: 0,
    pressureSoftPauseBytes: 1024,
    lastPruneAt: null,
    bySource: null,
    now: NOW,
  });
  const joined = lines.join('\n');
  expect(joined).not.toContain('Quarantined');
});

test('renderBufferSection prints per-source pending sub-rows with bytes when any source has pending', () => {
  const lines = renderBufferSection({
    pendingCount: 5,
    pendingBytes: 1024,
    failedCount: 0,
    failedBytes: 0,
    receiptsCount: 0,
    pressurePendingBytes: 1024,
    pressureSoftPauseBytes: 1024 * 1024,
    lastPruneAt: null,
    bySource: {
      'claude-code': { pending: 3, pendingBytes: 700, failed: 0, failedBytes: 0, delivered: 0 },
      cursor: { pending: 2, pendingBytes: 324, failed: 0, failedBytes: 0, delivered: 0 },
      codex: { pending: 0, pendingBytes: 0, failed: 0, failedBytes: 0, delivered: 0 },
      'gemini-cli': { pending: 0, pendingBytes: 0, failed: 0, failedBytes: 0, delivered: 0 },
    },
    now: NOW,
  });
  const joined = lines.join('\n');
  expect(joined).toContain('Claude Code');
  expect(joined).toContain('Cursor');
  expect(joined).not.toContain('Codex');
  expect(joined).toContain('never');
  expect(joined).toContain('700 B');
  expect(joined).toContain('324 B');
});

test('renderBufferSection prints per-source failed sub-rows when failed count > 0', () => {
  const lines = renderBufferSection({
    pendingCount: 0,
    pendingBytes: 0,
    failedCount: 4,
    failedBytes: 4096,
    receiptsCount: 0,
    pressurePendingBytes: 0,
    pressureSoftPauseBytes: 1024 * 1024,
    lastPruneAt: null,
    bySource: {
      'claude-code': {
        pending: 0,
        pendingBytes: 0,
        failed: 3,
        failedBytes: 3 * 1024,
        delivered: 0,
      },
      cursor: { pending: 0, pendingBytes: 0, failed: 1, failedBytes: 1024, delivered: 0 },
      codex: { pending: 0, pendingBytes: 0, failed: 0, failedBytes: 0, delivered: 0 },
      'gemini-cli': { pending: 0, pendingBytes: 0, failed: 0, failedBytes: 0, delivered: 0 },
    },
    now: NOW,
  });
  const joined = lines.join('\n');
  expect(joined).toContain('Claude Code');
  expect(joined).toContain('Cursor');
});

test('renderUploadSection writes all-time, avg, last cycle, last success when populated', () => {
  const lines = renderUploadSection({
    totalBatchesShipped: 86,
    totalBytesShipped: 12 * 1024 * 1024,
    drainCyclesTotal: 54,
    drainCyclesTotalDurationMs: 22_000,
    shippedBySource: {
      'claude-code': { batches: 70, bytes: 9 * 1024 * 1024 },
      cursor: { batches: 14, bytes: 2 * 1024 * 1024 },
      codex: { batches: 2, bytes: 512 * 1024 },
      'gemini-cli': { batches: 0, bytes: 0 },
    },
    lastCycleCompletedAt: '2026-05-08T13:28:50Z',
    lastCycleAttempted: 0,
    lastCycleAccepted: 0,
    lastCycleRetriable: 0,
    lastCycleFatal: 0,
    lastSuccessAt: '2026-05-08T13:25:42Z',
    lastSuccessBatches: 3,
    lastSuccessBytes: 410 * 1024,
    now: NOW,
  });
  const joined = lines.join('\n');
  expect(joined).toContain('All-time');
  expect(joined).toContain('86');
  expect(joined).toContain('batches shipped');
  expect(joined).toContain('Claude Code');
  expect(joined).toContain('Cursor');
  expect(joined).toContain('Codex');
  expect(joined).not.toMatch(/Gemini CLI\s+0 batches/);
  expect(joined).toContain('Avg / drain');
  expect(joined).toContain('Last drain');
  expect(joined).toContain('Last success');
  expect(joined).toContain('3 batches');
});

test('renderUploadSection falls back to dim placeholders when no cycles completed', () => {
  const lines = renderUploadSection({
    totalBatchesShipped: 0,
    totalBytesShipped: 0,
    drainCyclesTotal: 0,
    drainCyclesTotalDurationMs: 0,
    shippedBySource: null,
    lastCycleCompletedAt: null,
    lastCycleAttempted: null,
    lastCycleAccepted: null,
    lastCycleRetriable: null,
    lastCycleFatal: null,
    lastSuccessAt: null,
    lastSuccessBatches: null,
    lastSuccessBytes: null,
    now: NOW,
  });
  const joined = lines.join('\n');
  expect(joined).toContain('no drain cycles completed yet');
  expect(joined).toContain('no drain cycles yet');
  expect(joined).toContain('no drain completed yet');
  expect(joined).toContain('no successful upload yet');
});

test('renderUploadSection colors retriable and fatal when nonzero, omits zero per-source rows', () => {
  const lines = renderUploadSection({
    totalBatchesShipped: 1,
    totalBytesShipped: 1,
    drainCyclesTotal: 1,
    drainCyclesTotalDurationMs: 100,
    shippedBySource: {
      'claude-code': { batches: 1, bytes: 1 },
      cursor: { batches: 0, bytes: 0 },
      codex: { batches: 0, bytes: 0 },
      'gemini-cli': { batches: 0, bytes: 0 },
    },
    lastCycleCompletedAt: '2026-05-08T13:28:50Z',
    lastCycleAttempted: 5,
    lastCycleAccepted: 1,
    lastCycleRetriable: 2,
    lastCycleFatal: 2,
    lastSuccessAt: null,
    lastSuccessBatches: null,
    lastSuccessBytes: null,
    now: NOW,
  });
  const joined = lines.join('\n');
  expect(joined).toContain('2 retriable');
  expect(joined).toContain('2 fatal');
  expect(joined).toContain('Claude Code');
  expect(joined).not.toMatch(/Cursor\s+0 batches/);
});

test('renderUploadSection: all-time data without bysource shows summary line only', () => {
  const lines = renderUploadSection({
    totalBatchesShipped: 5,
    totalBytesShipped: 4096,
    drainCyclesTotal: 1,
    drainCyclesTotalDurationMs: 100,
    shippedBySource: null,
    lastCycleCompletedAt: null,
    lastCycleAttempted: null,
    lastCycleAccepted: null,
    lastCycleRetriable: null,
    lastCycleFatal: null,
    lastSuccessAt: null,
    lastSuccessBatches: null,
    lastSuccessBytes: null,
    now: NOW,
  });
  const joined = lines.join('\n');
  expect(joined).toContain('All-time');
  expect(joined).toContain('batches shipped');
  expect(joined).toContain('compressed');
});

test('renderHealthSection covers running daemon, no sentinels, current=latest, fresh binary', () => {
  const startedAt = new Date(NOW.getTime() - 3 * 60 * 60_000 - 14 * 60_000);
  const lines = renderHealthSection({
    daemon: { isRunning: true, pid: 78321, startedAt, now: NOW, installSource: 'npm' },
    sentinels: {
      authFailed: false,
      bufferFull: false,
      sessionStopped: false,
      updateAvailable: false,
    },
    autoUpgrade: {
      lastCheckAt: '2026-05-08T13:28:50Z',
      currentVersion: '2026.5.9-3',
      latestKnownVersion: '2026.5.9-3',
      installSource: 'npm',
      updateAvailableSentinelPresent: false,
      now: NOW,
    },
    binaryAge: {
      installedAt: new Date(NOW.getTime() - 14 * 86_400_000).toISOString(),
      warnAfterDays: DEFAULT_STALE_WARN_DAYS,
      pauseAfterDays: DEFAULT_STALE_PAUSE_DAYS,
      now: NOW,
    },
  });
  const joined = lines.join('\n');
  expect(joined).toContain('Daemon');
  expect(joined).toContain('running');
  expect(joined).toContain('pid 78321');
  expect(joined).toContain('uptime');
  expect(joined).toContain('Sentinels');
  expect(joined).toContain('none active');
  expect(joined).toContain('Auto-upgrade');
  expect(joined).toContain('up to date');
  expect(joined).toContain('Binary age');
  expect(joined).toContain('14 days');
});

test('renderHealthSection covers update sentinel, missing pid, and stale binary', () => {
  const lines = renderHealthSection({
    daemon: { isRunning: true, pid: null, startedAt: null, now: NOW, installSource: null },
    sentinels: {
      authFailed: false,
      bufferFull: false,
      sessionStopped: false,
      updateAvailable: true,
    },
    autoUpgrade: {
      lastCheckAt: null,
      currentVersion: '2026.5.9-3',
      latestKnownVersion: '2026.5.10',
      installSource: null,
      updateAvailableSentinelPresent: true,
      now: NOW,
    },
    binaryAge: {
      installedAt: new Date(NOW.getTime() - 200 * 86_400_000).toISOString(),
      warnAfterDays: DEFAULT_STALE_WARN_DAYS,
      pauseAfterDays: DEFAULT_STALE_PAUSE_DAYS,
      now: NOW,
    },
  });
  const joined = lines.join('\n');
  expect(joined).toContain('update-available');
  expect(joined).toContain('update pending');
  expect(joined).toContain('200 days');
  expect(joined).toContain('never');
});

test('renderHealthSection covers warning binary age and queued-update branch', () => {
  const lines = renderHealthSection({
    daemon: { isRunning: false, pid: null, startedAt: null, now: NOW, installSource: null },
    sentinels: {
      authFailed: true,
      bufferFull: true,
      sessionStopped: true,
      updateAvailable: false,
    },
    autoUpgrade: {
      lastCheckAt: '2026-05-08T13:28:50Z',
      currentVersion: '2026.5.9-3',
      latestKnownVersion: '2026.5.10',
      installSource: null,
      updateAvailableSentinelPresent: false,
      now: NOW,
    },
    binaryAge: {
      installedAt: new Date(NOW.getTime() - 100 * 86_400_000).toISOString(),
      warnAfterDays: DEFAULT_STALE_WARN_DAYS,
      pauseAfterDays: DEFAULT_STALE_PAUSE_DAYS,
      now: NOW,
    },
  });
  const joined = lines.join('\n');
  expect(joined).toContain('not running');
  expect(joined).toContain('auth-failed');
  expect(joined).toContain('buffer-full');
  expect(joined).toContain('session-stopped');
  expect(joined).toContain('update queued for next cycle');
  expect(joined).toContain('100 days');
});

test('renderHealthSection handles unknown installedAt and invalid timestamps', () => {
  const a = renderHealthSection({
    daemon: { isRunning: true, pid: 1, startedAt: NOW, now: NOW, installSource: null },
    sentinels: {
      authFailed: false,
      bufferFull: false,
      sessionStopped: false,
      updateAvailable: false,
    },
    autoUpgrade: {
      lastCheckAt: null,
      currentVersion: 'v',
      latestKnownVersion: null,
      installSource: null,
      updateAvailableSentinelPresent: false,
      now: NOW,
    },
    binaryAge: {
      installedAt: null,
      warnAfterDays: DEFAULT_STALE_WARN_DAYS,
      pauseAfterDays: DEFAULT_STALE_PAUSE_DAYS,
      now: NOW,
    },
  });
  expect(a.join('\n')).toContain('unknown');

  const b = renderHealthSection({
    daemon: { isRunning: true, pid: 1, startedAt: NOW, now: NOW, installSource: null },
    sentinels: {
      authFailed: false,
      bufferFull: false,
      sessionStopped: false,
      updateAvailable: false,
    },
    autoUpgrade: {
      lastCheckAt: null,
      currentVersion: 'v',
      latestKnownVersion: null,
      installSource: null,
      updateAvailableSentinelPresent: false,
      now: NOW,
    },
    binaryAge: {
      installedAt: 'not-a-date',
      warnAfterDays: DEFAULT_STALE_WARN_DAYS,
      pauseAfterDays: DEFAULT_STALE_PAUSE_DAYS,
      now: NOW,
    },
  });
  expect(b.join('\n')).toContain('unknown');
});

test('renderHealthSection: future-installed binary clamps to 0 days', () => {
  const lines = renderHealthSection({
    daemon: { isRunning: true, pid: 1, startedAt: NOW, now: NOW, installSource: null },
    sentinels: {
      authFailed: false,
      bufferFull: false,
      sessionStopped: false,
      updateAvailable: false,
    },
    autoUpgrade: {
      lastCheckAt: null,
      currentVersion: 'v',
      latestKnownVersion: null,
      installSource: null,
      updateAvailableSentinelPresent: false,
      now: NOW,
    },
    binaryAge: {
      installedAt: new Date(NOW.getTime() + 86_400_000).toISOString(),
      warnAfterDays: DEFAULT_STALE_WARN_DAYS,
      pauseAfterDays: DEFAULT_STALE_PAUSE_DAYS,
      now: NOW,
    },
  });
  expect(lines.join('\n')).toContain('0 days');
});

test('renderCaptureCyclesLine: zero state shows no cycles yet', () => {
  const line = renderCaptureCyclesLine(0, 0, null, NOW);
  expect(line).toContain('0');
  expect(line).toContain('no cycles yet');
});

test('renderCaptureCyclesLine: with errors and last timestamp', () => {
  const line = renderCaptureCyclesLine(7, 2, '2026-05-08T13:31:00Z', NOW);
  expect(line).toContain('7');
  expect(line).toContain('2 with errors');
  expect(line).toContain('last');
});

test('renderCaptureCyclesLine: zero errors shows dim-styled zero', () => {
  const line = renderCaptureCyclesLine(3, 0, '2026-05-08T13:31:00Z', NOW);
  expect(line).toContain('0');
  expect(line).toContain('with errors');
});

test('renderHealthSection shows configured stale-binary thresholds via constants', () => {
  const lines = renderHealthSection({
    daemon: { isRunning: true, pid: 1, startedAt: NOW, now: NOW, installSource: null },
    sentinels: {
      authFailed: false,
      bufferFull: false,
      sessionStopped: false,
      updateAvailable: false,
    },
    autoUpgrade: {
      lastCheckAt: null,
      currentVersion: 'v',
      latestKnownVersion: null,
      installSource: null,
      updateAvailableSentinelPresent: false,
      now: NOW,
    },
    binaryAge: {
      installedAt: new Date(NOW.getTime() - 5 * 86_400_000).toISOString(),
      warnAfterDays: DEFAULT_STALE_WARN_DAYS,
      pauseAfterDays: DEFAULT_STALE_PAUSE_DAYS,
      now: NOW,
    },
  });
  const joined = lines.join('\n');
  expect(joined).toContain(
    `warn ≥ ${DEFAULT_STALE_WARN_DAYS.toString()} d, pause ≥ ${DEFAULT_STALE_PAUSE_DAYS.toString()} d`,
  );
});

test('formatSourceLabel default case fallback for custom name', () => {
  const { formatSourceLabel } = require('../layout.ts');
  expect(formatSourceLabel('my-custom-source')).toBe('My Custom Source');
});
