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
    bufferFull: true,
  });
  expect(s.level).toBe('error');
  expect(s.headline).toContain('authentication');
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

test('session stopped state is below auth failure', () => {
  const s = deriveUnifiedSummary({
    ...BASE,
    sessionStopped: true,
  });
  expect(s.level).toBe('warning');
  expect(s.headline).toContain('stopped');
});

test('dev profile: not configured returns inactive level with dev setup hint', () => {
  const s = deriveUnifiedSummary({ ...BASE, configured: false, profileName: 'dev' });
  expect(s.level).toBe('inactive');
  expect(s.headline).toContain('Not set up');
  expect(s.hint).toContain('--profile dev');
});

test('dev profile: auth failure returns error level with dev setup force hint', () => {
  const s = deriveUnifiedSummary({ ...BASE, authFailed: true, profileName: 'dev' });
  expect(s.level).toBe('error');
  expect(s.headline).toContain('authentication');
  expect(s.hint).toContain('--profile dev --force');
});

test('dev profile: session stopped returns dev-specific headline and hint', () => {
  const s = deriveUnifiedSummary({ ...BASE, sessionStopped: true, profileName: 'dev' });
  expect(s.level).toBe('warning');
  expect(s.headline).toContain('Dev daemon stopped');
  expect(s.hint).toContain('Restart your dev daemon');
});

test('dev profile: daemon active (inferred alive) returns dev-specific active headline', () => {
  const recent = new Date(Date.now() - 8_000).toISOString();
  const s = deriveUnifiedSummary({
    ...BASE,
    daemonRunning: false,
    daemonInferredAlive: true,
    daemonLastCycleAt: recent,
    profileName: 'dev',
  });
  expect(s.level).toBe('ok');
  expect(s.headline).toContain('Dev daemon active');
  expect(s.hint).toContain('Stop with Ctrl-C');
});

test('dev profile: daemon not running returns dev-specific warning', () => {
  const s = deriveUnifiedSummary({ ...BASE, daemonRunning: false, profileName: 'dev' });
  expect(s.level).toBe('warning');
  expect(s.headline).toContain('Dev daemon is not running');
  expect(s.hint).toContain('Start it with');
});

test('dev profile: healthy state returns dev-specific running headline', () => {
  const s = deriveUnifiedSummary({ ...BASE, profileName: 'dev' });
  expect(s.level).toBe('ok');
  expect(s.headline).toContain('Dev daemon is running');
});
