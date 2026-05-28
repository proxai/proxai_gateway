import { expect, test } from 'bun:test';
import { buildDevDeps } from 'cli/wiring/dev-deps.ts';

test('buildDevDeps returns correct dev command dependencies', () => {
  const deps = buildDevDeps();
  expect(deps.output).toBeDefined();
  expect(typeof deps.devModeSentinelPath).toBe('string');
  expect(deps.devModeSentinelPath).toContain('DEV_MODE');
  expect(deps.devCtx.name).toBe('dev');
  expect(deps.devCtx.isDev).toBe(true);
  expect(typeof deps.devConfigExists).toBe('function');
  expect(typeof deps.verifyKey).toBe('function');
  expect(typeof deps.writeDevConfig).toBe('function');
  expect(typeof deps.registerDevServiceUnit).toBe('function');
});
