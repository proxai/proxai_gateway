import { expect, test } from 'bun:test';

import { buildResumeDeps } from 'cli/wiring/resume-deps.ts';

test('buildResumeDeps: returns output and sentinelPath', () => {
  const deps = buildResumeDeps();
  expect(typeof deps.output.info).toBe('function');
  expect(typeof deps.sentinelPath).toBe('string');
  expect(deps.sentinelPath.length).toBeGreaterThan(0);
});
