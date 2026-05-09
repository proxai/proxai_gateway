import { expect, test } from 'bun:test';

import { buildUpgradeDeps, buildUpgradeOptions } from 'cli/wiring/upgrade-deps.ts';

test('buildUpgradeDeps: returns deps with currentVersion + binaryPath + prompts + output', () => {
  const deps = buildUpgradeDeps({ binaryPath: '/bin/p' });
  expect(typeof deps.currentVersion).toBe('string');
  expect(deps.binaryPath).toBe('/bin/p');
  expect(typeof deps.output.info).toBe('function');
  expect(deps.prompts).toBeDefined();
});

test('buildUpgradeOptions: forwards yes and force when true', () => {
  expect(buildUpgradeOptions({ yes: true, force: true })).toEqual({ yes: true, force: true });
});

test('buildUpgradeOptions: omits flags when false or undefined', () => {
  expect(buildUpgradeOptions({})).toEqual({});
  expect(buildUpgradeOptions({ yes: false, force: false })).toEqual({});
});
