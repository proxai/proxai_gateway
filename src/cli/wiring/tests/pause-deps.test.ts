import { expect, test } from 'bun:test';

import { buildPauseDeps, buildPauseOptions } from 'cli/wiring/pause-deps.ts';

test('buildPauseDeps: returns output and sentinelPath', () => {
  const deps = buildPauseDeps();
  expect(typeof deps.output.info).toBe('function');
  expect(typeof deps.sentinelPath).toBe('string');
  expect(deps.sentinelPath.length).toBeGreaterThan(0);
});

test('buildPauseOptions: includes reason when provided', () => {
  expect(buildPauseOptions({ reason: 'maintenance' })).toEqual({ reason: 'maintenance' });
});

test('buildPauseOptions: omits reason when undefined', () => {
  expect(buildPauseOptions({})).toEqual({});
});
