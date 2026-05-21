import { expect, test } from 'bun:test';
import { buildDevDeps } from 'cli/wiring/dev-deps.ts';

test('buildDevDeps returns correct dev command dependencies', () => {
  const deps = buildDevDeps();
  expect(deps.output).toBeDefined();
  expect(typeof deps.sentinelPath).toBe('string');
  expect(deps.sentinelPath).toContain('DEV_MODE');
});
