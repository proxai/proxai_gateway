import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rmRecursive } from 'core/io/fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runRestart } from 'cli/commands/restart.ts';
import { captureOutput } from 'cli/output.ts';
import type { ServiceManager } from 'cli/service-manager';
import {
  readSessionStoppedSentinel,
  writeSessionStoppedSentinel,
} from 'services/polling/session-stopped-sentinel.ts';

interface FakeCalls {
  ensureRegistered: number;
  start: number;
  stop: number;
  restart: number;
  isRegistered: number;
  isRunning: number;
}

function fakeManager(
  overrides: Partial<{
    failOn: 'ensureRegistered' | 'restart';
  }> = {},
): { sm: ServiceManager; calls: FakeCalls } {
  const calls: FakeCalls = {
    ensureRegistered: 0,
    start: 0,
    stop: 0,
    restart: 0,
    isRegistered: 0,
    isRunning: 0,
  };
  const sm: ServiceManager = {
    isRegistered: async () => {
      calls.isRegistered++;
      return true;
    },
    isRunning: async () => {
      calls.isRunning++;
      return true;
    },
    ensureRegistered: async () => {
      calls.ensureRegistered++;
      if (overrides.failOn === 'ensureRegistered') throw new Error('boom-register');
    },
    start: async () => {
      calls.start++;
    },
    stop: async () => {
      calls.stop++;
    },
    restart: async () => {
      calls.restart++;
      if (overrides.failOn === 'restart') throw new Error('boom-restart');
    },
    unregister: async () => undefined,
    runtimeInfo: async () => ({ pid: null, startedAt: null }),
  };
  return { sm, calls };
}

let dir: string;
let sentinelPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-restart-'));
  sentinelPath = join(dir, 'SESSION_STOPPED');
});

afterEach(async () => {
  await rmRecursive(dir);
});

test('redirects to setup when config missing', async () => {
  const { sm, calls } = fakeManager();
  const output = captureOutput();
  let invokeSetupCalls = 0;
  const result = await runRestart({
    output,
    configExists: async () => false,
    serviceManager: sm,
    sessionStoppedSentinelPath: sentinelPath,
    invokeSetup: async () => {
      invokeSetupCalls++;
      return { exitCode: 0 };
    },
  });
  expect(result.exitCode).toBe(0);
  expect(invokeSetupCalls).toBe(1);
  expect(calls.restart).toBe(0);
});

test('ensureRegistered + restart when config exists', async () => {
  const { sm, calls } = fakeManager();
  const output = captureOutput();
  const result = await runRestart({
    output,
    configExists: async () => true,
    serviceManager: sm,
    sessionStoppedSentinelPath: sentinelPath,
  });
  expect(result.exitCode).toBe(0);
  expect(calls.ensureRegistered).toBe(1);
  expect(calls.restart).toBe(1);
  expect(output.lines.some((l) => l.level === 'success' && l.msg.includes('restarted'))).toBe(true);
});

test('clears the SESSION_STOPPED sentinel as part of restart', async () => {
  await writeSessionStoppedSentinel(sentinelPath, {
    bootId: 'prior-boot',
    setAt: '2026-05-06T00:00:00.000Z',
  });
  const { sm } = fakeManager();
  const output = captureOutput();
  const result = await runRestart({
    output,
    configExists: async () => true,
    serviceManager: sm,
    sessionStoppedSentinelPath: sentinelPath,
  });
  expect(result.exitCode).toBe(0);
  expect(await readSessionStoppedSentinel(sentinelPath)).toBeNull();
});

test('returns error when restart throws', async () => {
  const { sm, calls } = fakeManager({ failOn: 'restart' });
  const output = captureOutput();
  const result = await runRestart({
    output,
    configExists: async () => true,
    serviceManager: sm,
    sessionStoppedSentinelPath: sentinelPath,
  });
  expect(result.exitCode).toBe(1);
  expect(calls.restart).toBe(1);
  expect(output.lines.some((l) => l.level === 'error' && l.msg.includes('restart failed'))).toBe(
    true,
  );
});

test('returns error when invokeSetup is missing and config does not exist', async () => {
  const { sm } = fakeManager();
  const output = captureOutput();
  const result = await runRestart({
    output,
    configExists: async () => false,
    serviceManager: sm,
    sessionStoppedSentinelPath: sentinelPath,
  });
  expect(result.exitCode).toBe(1);
  expect(output.lines.some((l) => l.level === 'error')).toBe(true);
});

test('self-heals service unit when missing then proceeds with restart', async () => {
  const { sm, calls } = fakeManager();
  const output = captureOutput();
  let writes = 0;
  const result = await runRestart({
    output,
    configExists: async () => true,
    serviceManager: sm,
    sessionStoppedSentinelPath: sentinelPath,
    serviceUnitRecreate: {
      serviceUnitPath: join(dir, 'co.proxai.gateway.plist'),
      programPath: '/tmp/proxai-gateway',
      platform: 'darwin',
    },
    serviceUnitFileExists: async () => false,
    writeServiceUnitFn: async () => {
      writes++;
    },
  });
  expect(result.exitCode).toBe(0);
  expect(writes).toBe(1);
  expect(calls.ensureRegistered).toBe(1);
  expect(calls.restart).toBe(1);
  expect(output.lines.some((l) => l.msg.includes('service unit missing'))).toBe(true);
});

test('skips service unit write when file exists', async () => {
  const { sm, calls } = fakeManager();
  const output = captureOutput();
  let writes = 0;
  const result = await runRestart({
    output,
    configExists: async () => true,
    serviceManager: sm,
    sessionStoppedSentinelPath: sentinelPath,
    serviceUnitRecreate: {
      serviceUnitPath: join(dir, 'co.proxai.gateway.plist'),
      programPath: '/tmp/proxai-gateway',
      platform: 'darwin',
    },
    serviceUnitFileExists: async () => true,
    writeServiceUnitFn: async () => {
      writes++;
    },
  });
  expect(result.exitCode).toBe(0);
  expect(writes).toBe(0);
  expect(calls.restart).toBe(1);
});

test('formatError stringifies non-Error throws', async () => {
  const sm: ServiceManager = {
    isRegistered: async () => true,
    isRunning: async () => true,
    ensureRegistered: async () => undefined,
    start: async () => undefined,
    stop: async () => undefined,
    restart: async () => {
      throw 'rope-throw';
    },
    unregister: async () => undefined,
    runtimeInfo: async () => ({ pid: null, startedAt: null }),
  };
  const output = captureOutput();
  const result = await runRestart({
    output,
    configExists: async () => true,
    serviceManager: sm,
    sessionStoppedSentinelPath: sentinelPath,
  });
  expect(result.exitCode).toBe(1);
  expect(
    output.lines.some((l) => l.level === 'error' && l.msg.includes('restart failed: rope-throw')),
  ).toBe(true);
});
