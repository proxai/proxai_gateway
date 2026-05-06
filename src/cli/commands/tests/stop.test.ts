import { expect, test } from 'bun:test';

import { runStop } from 'cli/commands/stop.ts';
import { captureOutput } from 'cli/output.ts';
import type { ServiceManager } from 'cli/service-manager.ts';

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
  };
  return { sm, calls };
}

test('idempotent when not registered', async () => {
  const { sm, calls } = fakeManager({ isRegistered: false });
  const output = captureOutput();
  const result = await runStop({ output, serviceManager: sm });
  expect(result.exitCode).toBe(0);
  expect(calls.stop).toBe(0);
  expect(output.lines.some((l) => l.level === 'info' && l.msg.includes('not registered'))).toBe(
    true,
  );
});

test('stops when registered', async () => {
  const { sm, calls } = fakeManager({ isRegistered: true });
  const output = captureOutput();
  const result = await runStop({ output, serviceManager: sm });
  expect(result.exitCode).toBe(0);
  expect(calls.stop).toBe(1);
  expect(output.lines.some((l) => l.level === 'success' && l.msg.includes('stopped'))).toBe(true);
});

test('returns error when stop throws', async () => {
  const { sm, calls } = fakeManager({ isRegistered: true, failOn: 'stop' });
  const output = captureOutput();
  const result = await runStop({ output, serviceManager: sm });
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
  };
  const output = captureOutput();
  const result = await runStop({ output, serviceManager: sm });
  expect(result.exitCode).toBe(1);
  expect(
    output.lines.some((l) => l.level === 'error' && l.msg.includes('stop failed: rope-throw')),
  ).toBe(true);
});
