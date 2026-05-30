import { expect, test } from 'bun:test';

import { buildUpgradeDeps, buildUpgradeOptions } from 'cli/wiring/upgrade-deps.ts';

test('buildUpgradeDeps: returns deps with currentVersion + binaryPath + output', () => {
  const deps = buildUpgradeDeps({ binaryPath: '/bin/p' });
  expect(typeof deps.currentVersion).toBe('string');
  expect(deps.binaryPath).toBe('/bin/p');
  expect(typeof deps.output.info).toBe('function');
});

test('buildUpgradeOptions: parses force flag correctly', () => {
  expect(buildUpgradeOptions({ force: true })).toEqual({ force: true });
  expect(buildUpgradeOptions({})).toEqual({});
});
