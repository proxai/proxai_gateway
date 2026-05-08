import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rmRecursive } from 'core/io/fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runStart } from 'cli/commands/start.ts';
import { captureOutput } from 'cli/output.ts';
import type { ServiceManager } from 'cli/service-manager.ts';
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
    isRegistered: boolean;
    isRunning: boolean;
    failOn: 'ensureRegistered' | 'start' | 'stop' | 'restart';
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
      return overrides.isRegistered ?? false;
    },
    isRunning: async () => {
      calls.isRunning++;
      return overrides.isRunning ?? false;
    },
    ensureRegistered: async () => {
      calls.ensureRegistered++;
      if (overrides.failOn === 'ensureRegistered') throw new Error('boom-register');
    },
    start: async () => {
      calls.start++;
      if (overrides.failOn === 'start') throw new Error('boom-start');
    },
    stop: async () => {
      calls.stop++;
      if (overrides.failOn === 'stop') throw new Error('boom-stop');
    },
    restart: async () => {
      calls.restart++;
      if (overrides.failOn === 'restart') throw new Error('boom-restart');
    },
    unregister: async () => undefined,
  };
  return { sm, calls };
}

let dir: string;
let sentinelPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-start-'));
  sentinelPath = join(dir, 'SESSION_STOPPED');
});

afterEach(async () => {
  await rmRecursive(dir);
});

test('redirects to setup when config missing', async () => {
  const { sm, calls } = fakeManager();
  const output = captureOutput();
  let invokeSetupCalls = 0;
  const result = await runStart({
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
  expect(calls.ensureRegistered).toBe(0);
  expect(calls.start).toBe(0);
  expect(output.lines.some((l) => l.level === 'warn' && l.msg.includes('first-time setup'))).toBe(
    true,
  );
});

test('ensureRegistered + start when config exists', async () => {
  const { sm, calls } = fakeManager();
  const output = captureOutput();
  const result = await runStart({
    output,
    configExists: async () => true,
    serviceManager: sm,
    sessionStoppedSentinelPath: sentinelPath,
    invokeSetup: async () => ({ exitCode: 0 }),
  });
  expect(result.exitCode).toBe(0);
  expect(calls.ensureRegistered).toBe(1);
  expect(calls.start).toBe(1);
  expect(output.lines.some((l) => l.level === 'success' && l.msg.includes('started'))).toBe(true);
});

test('clears the SESSION_STOPPED sentinel before serviceManager.start()', async () => {
  await writeSessionStoppedSentinel(sentinelPath, {
    bootId: 'prior-boot',
    setAt: '2026-05-06T00:00:00.000Z',
  });
  let startSawSentinelCleared = false;
  const sm: ServiceManager = {
    isRegistered: async () => false,
    isRunning: async () => false,
    ensureRegistered: async () => undefined,
    start: async () => {
      startSawSentinelCleared = (await readSessionStoppedSentinel(sentinelPath)) === null;
    },
    stop: async () => undefined,
    restart: async () => undefined,
    unregister: async () => undefined,
  };
  const output = captureOutput();
  const result = await runStart({
    output,
    configExists: async () => true,
    serviceManager: sm,
    sessionStoppedSentinelPath: sentinelPath,
  });
  expect(result.exitCode).toBe(0);
  expect(startSawSentinelCleared).toBe(true);
  expect(await readSessionStoppedSentinel(sentinelPath)).toBeNull();
});

test('clear is idempotent when no sentinel exists', async () => {
  const { sm } = fakeManager();
  const output = captureOutput();
  const result = await runStart({
    output,
    configExists: async () => true,
    serviceManager: sm,
    sessionStoppedSentinelPath: sentinelPath,
  });
  expect(result.exitCode).toBe(0);
  expect(await readSessionStoppedSentinel(sentinelPath)).toBeNull();
});

test('returns error when start throws', async () => {
  const { sm, calls } = fakeManager({ failOn: 'start' });
  const output = captureOutput();
  const result = await runStart({
    output,
    configExists: async () => true,
    serviceManager: sm,
    sessionStoppedSentinelPath: sentinelPath,
  });
  expect(result.exitCode).toBe(1);
  expect(calls.start).toBe(1);
  expect(output.lines.some((l) => l.level === 'error' && l.msg.includes('start failed'))).toBe(
    true,
  );
});

test('returns error when invokeSetup is missing and config does not exist', async () => {
  const { sm } = fakeManager();
  const output = captureOutput();
  const result = await runStart({
    output,
    configExists: async () => false,
    serviceManager: sm,
    sessionStoppedSentinelPath: sentinelPath,
  });
  expect(result.exitCode).toBe(1);
  expect(output.lines.some((l) => l.level === 'error')).toBe(true);
});

test('self-heals service unit when serviceUnitPath is missing then proceeds', async () => {
  const { sm, calls } = fakeManager();
  const output = captureOutput();
  let writes = 0;
  const writtenPaths: string[] = [];
  const result = await runStart({
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
    writeServiceUnitFn: async (input) => {
      writes++;
      writtenPaths.push(input.serviceUnitPath);
    },
  });
  expect(result.exitCode).toBe(0);
  expect(writes).toBe(1);
  expect(writtenPaths).toEqual([join(dir, 'co.proxai.gateway.plist')]);
  expect(calls.ensureRegistered).toBe(1);
  expect(calls.start).toBe(1);
  expect(output.lines.some((l) => l.msg.includes('service unit missing'))).toBe(true);
});

test('does not rewrite service unit when it already exists', async () => {
  const { sm, calls } = fakeManager();
  const output = captureOutput();
  let writes = 0;
  const result = await runStart({
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
  expect(calls.ensureRegistered).toBe(1);
  expect(calls.start).toBe(1);
  expect(output.lines.every((l) => !l.msg.includes('service unit missing'))).toBe(true);
});

test('formatError stringifies non-Error throws', async () => {
  const calls: FakeCalls = {
    ensureRegistered: 0,
    start: 0,
    stop: 0,
    restart: 0,
    isRegistered: 0,
    isRunning: 0,
  };
  const sm: ServiceManager = {
    isRegistered: async () => false,
    isRunning: async () => false,
    ensureRegistered: async () => {
      calls.ensureRegistered++;
    },

    start: async () => {
      throw 'rope-throw';
    },
    stop: async () => undefined,
    restart: async () => undefined,
    unregister: async () => undefined,
  };
  const output = captureOutput();
  const result = await runStart({
    output,
    configExists: async () => true,
    serviceManager: sm,
    sessionStoppedSentinelPath: sentinelPath,
  });
  expect(result.exitCode).toBe(1);
  expect(
    output.lines.some((l) => l.level === 'error' && l.msg.includes('start failed: rope-throw')),
  ).toBe(true);
});
