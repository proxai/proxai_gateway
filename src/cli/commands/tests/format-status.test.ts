import { expect, test } from 'bun:test';

import {
  formatDuration,
  formatPercent,
  renderBufferSection,
  renderCaptureRow,
  renderHealthSection,
  renderUploadSection,
} from 'cli/commands/format-status.ts';

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
  expect(line).toContain('cursor');
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
    pendingBySource: null,
    now: NOW,
  });
  const joined = lines.join('\n');
  expect(joined).toContain('Buffer');
  expect(joined).toContain('Pending');
  expect(joined).toContain('Failed');
  expect(joined).toContain('Receipts');
  expect(joined).toContain('86 records');
  expect(joined).toContain('Pressure');
  expect(joined).toContain('soft-pause threshold');
  expect(joined).toContain('Last prune');
});

test('renderBufferSection prints per-source pending sub-rows when any source has pending', () => {
  const lines = renderBufferSection({
    pendingCount: 5,
    pendingBytes: 1024,
    failedCount: 0,
    failedBytes: 0,
    receiptsCount: 0,
    pressurePendingBytes: 1024,
    pressureSoftPauseBytes: 1024 * 1024,
    lastPruneAt: null,
    pendingBySource: {
      'claude-code': { pending: 3, failed: 0, delivered: 0 },
      cursor: { pending: 2, failed: 0, delivered: 0 },
      codex: { pending: 0, failed: 0, delivered: 0 },
      'gemini-cli': { pending: 0, failed: 0, delivered: 0 },
    },
    now: NOW,
  });
  const joined = lines.join('\n');
  expect(joined).toContain('claude-code');
  expect(joined).toContain('cursor');
  expect(joined).toContain('never');
});

test('renderUploadSection writes all-time, avg, last cycle, last success when populated', () => {
  const lines = renderUploadSection({
    totalBatchesShipped: 86,
    totalBytesShipped: 12 * 1024 * 1024,
    cyclesTotal: 54,
    cyclesTotalDurationMs: 22_000,
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
  expect(joined).toContain('86 batches shipped');
  expect(joined).toContain('Avg / cycle');
  expect(joined).toContain('Last cycle');
  expect(joined).toContain('Last success');
  expect(joined).toContain('3 batches');
});

test('renderUploadSection highlights retriable + fatal counts and falls back to dim placeholders', () => {
  const lines = renderUploadSection({
    totalBatchesShipped: 0,
    totalBytesShipped: 0,
    cyclesTotal: 0,
    cyclesTotalDurationMs: 0,
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
  expect(joined).toContain('no cycles completed yet');
  expect(joined).toContain('no cycle completed yet');
  expect(joined).toContain('no successful upload yet');
});

test('renderUploadSection colors retriable and fatal when nonzero', () => {
  const lines = renderUploadSection({
    totalBatchesShipped: 1,
    totalBytesShipped: 1,
    cyclesTotal: 1,
    cyclesTotalDurationMs: 100,
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
});

test('renderHealthSection covers running daemon, no sentinels, current=latest, fresh binary', () => {
  const startedAt = new Date(NOW.getTime() - 3 * 60 * 60_000 - 14 * 60_000);
  const lines = renderHealthSection({
    daemon: { isRunning: true, pid: 78321, startedAt, now: NOW, installSource: 'npm' },
    sentinels: {
      paused: false,
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
      warnAfterDays: 90,
      pauseAfterDays: 180,
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

test('renderHealthSection covers paused-and-update sentinels, missing pid, and stale binary', () => {
  const lines = renderHealthSection({
    daemon: { isRunning: true, pid: null, startedAt: null, now: NOW, installSource: null },
    sentinels: {
      paused: true,
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
      warnAfterDays: 90,
      pauseAfterDays: 180,
      now: NOW,
    },
  });
  const joined = lines.join('\n');
  expect(joined).toContain('paused');
  expect(joined).toContain('update-available');
  expect(joined).toContain('update pending');
  expect(joined).toContain('200 days');
  expect(joined).toContain('never');
});

test('renderHealthSection covers warning binary age and queued-update branch', () => {
  const lines = renderHealthSection({
    daemon: { isRunning: false, pid: null, startedAt: null, now: NOW, installSource: null },
    sentinels: {
      paused: false,
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
      warnAfterDays: 90,
      pauseAfterDays: 180,
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
      paused: false,
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
    binaryAge: { installedAt: null, warnAfterDays: 90, pauseAfterDays: 180, now: NOW },
  });
  expect(a.join('\n')).toContain('unknown');

  const b = renderHealthSection({
    daemon: { isRunning: true, pid: 1, startedAt: NOW, now: NOW, installSource: null },
    sentinels: {
      paused: false,
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
    binaryAge: { installedAt: 'not-a-date', warnAfterDays: 90, pauseAfterDays: 180, now: NOW },
  });
  expect(b.join('\n')).toContain('unknown');
});

test('renderHealthSection: future-installed binary clamps to 0 days', () => {
  const lines = renderHealthSection({
    daemon: { isRunning: true, pid: 1, startedAt: NOW, now: NOW, installSource: null },
    sentinels: {
      paused: false,
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
      warnAfterDays: 90,
      pauseAfterDays: 180,
      now: NOW,
    },
  });
  expect(lines.join('\n')).toContain('0 days');
});
