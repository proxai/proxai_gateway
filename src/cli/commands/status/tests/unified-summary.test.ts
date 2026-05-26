import { expect, test } from 'bun:test';
import { deriveUnifiedSummary } from 'cli/commands/status/unified-summary.ts';
import type { UnifiedSummaryInputs } from 'cli/commands/status/unified-summary.types.ts';

const BASE: UnifiedSummaryInputs = {
  configured: true,
  isDevMode: false,
  daemonRunning: true,
  daemonInferredAlive: false,
  daemonLastCycleAt: null,
  authFailed: false,
  paused: false,
  pausedReason: '',
  bufferFull: false,
  bufferFullPendingBytes: null,
  bufferFullThreshold: null,
  sessionStopped: false,
};

test('not configured returns inactive level with setup hint', () => {
  const s = deriveUnifiedSummary({ ...BASE, configured: false });
  expect(s.level).toBe('inactive');
  expect(s.headline).toContain('Not set up');
  expect(s.hint).toContain('setup');
});

test('healthy state returns ok level without hint', () => {
  const s = deriveUnifiedSummary(BASE);
  expect(s.level).toBe('ok');
  expect(s.hint).toBeNull();
});

test('auth failure dominates other conditions', () => {
  const s = deriveUnifiedSummary({
    ...BASE,
    authFailed: true,
    paused: true,
    bufferFull: true,
  });
  expect(s.level).toBe('error');
  expect(s.headline).toContain('authentication');
});

test('paused state reports reason and resume hint', () => {
  const s = deriveUnifiedSummary({ ...BASE, paused: true, pausedReason: 'maintenance' });
  expect(s.level).toBe('warning');
  expect(s.headline).toContain('maintenance');
  expect(s.hint).toContain('resume');
});

test('buffer full state computes pressure percentage', () => {
  const s = deriveUnifiedSummary({
    ...BASE,
    bufferFull: true,
    bufferFullPendingBytes: 39_000_000_000,
    bufferFullThreshold: 50_000_000_000,
  });
  expect(s.level).toBe('warning');
  expect(s.headline).toContain('78%');
});

test('daemon not running reports start hint', () => {
  const s = deriveUnifiedSummary({ ...BASE, daemonRunning: false });
  expect(s.level).toBe('warning');
  expect(s.hint).toContain('start');
});

test('daemon not service-managed but recently cycled reports ok with registration hint', () => {
  const recent = new Date(Date.now() - 8_000).toISOString();
  const s = deriveUnifiedSummary({
    ...BASE,
    daemonRunning: false,
    daemonInferredAlive: true,
    daemonLastCycleAt: recent,
  });
  expect(s.level).toBe('ok');
  expect(s.headline).toContain('not registered with OS');
  expect(s.hint).toContain('Last cycle');
  expect(s.hint).toContain('start');
});

test('session stopped state is below auth failure but above paused', () => {
  const s = deriveUnifiedSummary({
    ...BASE,
    sessionStopped: true,
    paused: true,
  });
  expect(s.level).toBe('warning');
  expect(s.headline).toContain('stopped');
});
