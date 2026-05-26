import { expect, test } from 'bun:test';

import { buildUpgradeDeps } from 'cli/wiring/upgrade-deps.ts';

test('buildUpgradeDeps: returns deps with currentVersion + binaryPath + output', () => {
  const deps = buildUpgradeDeps({ binaryPath: '/bin/p' });
  expect(typeof deps.currentVersion).toBe('string');
  expect(deps.binaryPath).toBe('/bin/p');
  expect(typeof deps.output.info).toBe('function');
});
