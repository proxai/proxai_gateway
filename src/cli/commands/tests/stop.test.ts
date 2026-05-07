import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rmRecursive } from 'core/io/fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runStop } from 'cli/commands/stop.ts';
import { captureOutput } from 'cli/output.ts';
import type { ServiceManager } from 'cli/service-manager.ts';
import { readSessionStoppedSentinel } from 'services/polling/session-stopped-sentinel.ts';

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
    failOn: 'stop';
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
      return overrides.isRegistered ?? true;
    },
    isRunning: async () => {
      calls.isRunning++;
      return false;
    },
    ensureRegistered: async () => {
      calls.ensureRegistered++;
    },
    start: async () => {
      calls.start++;
    },
    stop: async () => {
      calls.stop++;
      if (overrides.failOn === 'stop') throw new Error('boom-stop');
    },
    restart: async () => {
      calls.restart++;
    },
    unregister: async () => undefined,
  };
  return { sm, calls };
}

let dir: string;
let sentinelPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-stop-'));
  sentinelPath = join(dir, 'SESSION_STOPPED');
});

afterEach(async () => {
  await rmRecursive(dir);
});

test('idempotent when not registered', async () => {
  const { sm, calls } = fakeManager({ isRegistered: false });
  const output = captureOutput();
  const result = await runStop({
    output,
    serviceManager: sm,
    sessionStoppedSentinelPath: sentinelPath,
    readBootId: async () => 'boot-test',
    now: () => '2026-05-06T00:00:00.000Z',
  });
  expect(result.exitCode).toBe(0);
  expect(calls.stop).toBe(0);
  expect(output.lines.some((l) => l.level === 'info' && l.msg.includes('not registered'))).toBe(
    true,
  );
});

test('writes the sentinel even when service is not registered', async () => {
  const { sm } = fakeManager({ isRegistered: false });
  const output = captureOutput();
  const result = await runStop({
    output,
    serviceManager: sm,
    sessionStoppedSentinelPath: sentinelPath,
    readBootId: async () => 'boot-test',
    now: () => '2026-05-06T00:00:00.000Z',
  });
  expect(result.exitCode).toBe(0);
  const payload = await readSessionStoppedSentinel(sentinelPath);
  expect(payload).not.toBeNull();
  expect(payload?.bootId).toBe('boot-test');
  expect(payload?.setAt).toBe('2026-05-06T00:00:00.000Z');
});

test('stops when registered', async () => {
  const { sm, calls } = fakeManager({ isRegistered: true });
  const output = captureOutput();
  const result = await runStop({
    output,
    serviceManager: sm,
    sessionStoppedSentinelPath: sentinelPath,
    readBootId: async () => 'boot-test',
    now: () => '2026-05-06T00:00:00.000Z',
  });
  expect(result.exitCode).toBe(0);
  expect(calls.stop).toBe(1);
  expect(output.lines.some((l) => l.level === 'success' && l.msg.includes('stopped'))).toBe(true);
});

test('writes the sentinel BEFORE invoking serviceManager.stop()', async () => {
  let stopSawSentinel = false;
  const sm: ServiceManager = {
    isRegistered: async () => true,
    isRunning: async () => false,
    ensureRegistered: async () => undefined,
    start: async () => undefined,
    stop: async () => {
      const payload = await readSessionStoppedSentinel(sentinelPath);
      stopSawSentinel = payload !== null && payload.bootId === 'boot-test';
    },
    restart: async () => undefined,
    unregister: async () => undefined,
  };
  const output = captureOutput();
  const result = await runStop({
    output,
    serviceManager: sm,
    sessionStoppedSentinelPath: sentinelPath,
    readBootId: async () => 'boot-test',
    now: () => '2026-05-06T00:00:00.000Z',
  });
  expect(result.exitCode).toBe(0);
  expect(stopSawSentinel).toBe(true);
});

test('returns error when stop throws', async () => {
  const { sm, calls } = fakeManager({ isRegistered: true, failOn: 'stop' });
  const output = captureOutput();
  const result = await runStop({
    output,
    serviceManager: sm,
    sessionStoppedSentinelPath: sentinelPath,
    readBootId: async () => 'boot-test',
    now: () => '2026-05-06T00:00:00.000Z',
  });
  expect(result.exitCode).toBe(1);
  expect(calls.stop).toBe(1);
  expect(output.lines.some((l) => l.level === 'error' && l.msg.includes('stop failed'))).toBe(true);
});

test('formatError stringifies non-Error throws', async () => {
  const sm: ServiceManager = {
    isRegistered: async () => true,
    isRunning: async () => false,
    ensureRegistered: async () => undefined,
    start: async () => undefined,
    stop: async () => {
      throw 'rope-throw';
    },
    restart: async () => undefined,
    unregister: async () => undefined,
  };
  const output = captureOutput();
  const result = await runStop({
    output,
    serviceManager: sm,
    sessionStoppedSentinelPath: sentinelPath,
    readBootId: async () => 'boot-test',
    now: () => '2026-05-06T00:00:00.000Z',
  });
  expect(result.exitCode).toBe(1);
  expect(
    output.lines.some((l) => l.level === 'error' && l.msg.includes('stop failed: rope-throw')),
  ).toBe(true);
});
