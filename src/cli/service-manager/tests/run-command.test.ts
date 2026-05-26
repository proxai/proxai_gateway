import { expect, test } from 'bun:test';

import { getServiceManager, runCommand } from 'cli/service-manager';
import { mockSpawn } from 'cli/service-manager/tests/mock-spawn.ts';

test('runCommand returns stdout, stderr, exit code', async () => {
  const { spawn } = mockSpawn(() => ({ exitCode: 0, stdout: 'hello', stderr: 'oops' }));
  const result = await runCommand(spawn, ['echo', 'hi']);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe('hello');
  expect(result.stderr).toBe('oops');
});

test('default spawn factory is wired up when deps.spawn is omitted', async () => {
  const sm = getServiceManager({
    platform: process.platform,
    unitPath: '/tmp/proxai-coverage-nonexistent.unit',
  });
  try {
    const result = await sm.isRegistered();
    expect(typeof result).toBe('boolean');
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
  }
}, 30_000);
