import { expect, test } from 'bun:test';

import { getServiceManager, parseSystemctlShow } from 'cli/service-manager';
import { mockSpawn } from 'cli/service-manager/tests/mock-spawn.ts';

test('isRegistered true when list-unit-files exits 0 with unit name', async () => {
  const { spawn, invocations } = mockSpawn(() => ({
    exitCode: 0,
    stdout: 'UNIT FILE                STATE  PRESET\nproxai-gateway.service   enabled enabled\n',
  }));
  const sm = getServiceManager({
    platform: 'linux',
    unitPath: '/etc/systemd/user/proxai-gateway.service',
    spawn,
  });
  expect(await sm.isRegistered()).toBe(true);
  expect(invocations[0]?.argv).toEqual([
    'systemctl',
    '--user',
    'list-unit-files',
    'proxai-gateway.service',
  ]);
});

test('isRegistered false when output empty', async () => {
  const { spawn } = mockSpawn(() => ({ exitCode: 0, stdout: '' }));
  const sm = getServiceManager({ platform: 'linux', unitPath: '/x', spawn });
  expect(await sm.isRegistered()).toBe(false);
});

test('isRunning true when is-active exits 0', async () => {
  const { spawn, invocations } = mockSpawn(() => ({ exitCode: 0, stdout: 'active' }));
  const sm = getServiceManager({ platform: 'linux', unitPath: '/x', spawn });
  expect(await sm.isRunning()).toBe(true);
  expect(invocations[0]?.argv).toEqual([
    'systemctl',
    '--user',
    'is-active',
    'proxai-gateway.service',
  ]);
});

test('ensureRegistered runs daemon-reload then enable', async () => {
  let enabledCalls = 0;
  const { spawn, invocations } = mockSpawn((argv) => {
    if (argv[2] === 'daemon-reload') return { exitCode: 0 };
    if (argv[2] === 'is-enabled') {
      enabledCalls++;
      return { exitCode: 1 };
    }
    if (argv[2] === 'enable') return { exitCode: 0 };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({ platform: 'linux', unitPath: '/x', spawn });
  await sm.ensureRegistered();
  expect(enabledCalls).toBe(1);
  expect(invocations.some((i) => i.argv[2] === 'enable')).toBe(true);
});

test('start runs systemctl start after ensure', async () => {
  const { spawn, invocations } = mockSpawn((argv) => {
    if (argv[2] === 'is-enabled') return { exitCode: 0 };
    return { exitCode: 0 };
  });
  const sm = getServiceManager({ platform: 'linux', unitPath: '/x', spawn });
  await sm.start();
  expect(invocations.some((i) => i.argv[2] === 'start')).toBe(true);
});

test('stop runs systemctl stop', async () => {
  const { spawn, invocations } = mockSpawn(() => ({ exitCode: 0 }));
  const sm = getServiceManager({ platform: 'linux', unitPath: '/x', spawn });
  await sm.stop();
  expect(invocations[0]?.argv).toEqual(['systemctl', '--user', 'stop', 'proxai-gateway.service']);
});

test('restart runs systemctl restart after ensure', async () => {
  const { spawn, invocations } = mockSpawn((argv) => {
    if (argv[2] === 'is-enabled') return { exitCode: 0 };
    return { exitCode: 0 };
  });
  const sm = getServiceManager({ platform: 'linux', unitPath: '/x', spawn });
  await sm.restart();
  expect(invocations.some((i) => i.argv[2] === 'restart')).toBe(true);
});

test('surfaces stderr in error message when systemctl fails', async () => {
  const { spawn } = mockSpawn(() => ({ exitCode: 5, stderr: 'bad unit' }));
  const sm = getServiceManager({ platform: 'linux', unitPath: '/x', spawn });
  await expect(sm.stop()).rejects.toThrow(/bad unit/);
});

test('ensureRegistered surfaces stderr when daemon-reload fails', async () => {
  const { spawn } = mockSpawn((argv) => {
    if (argv[2] === 'daemon-reload') return { exitCode: 7, stderr: 'reload broken' };
    return { exitCode: 0 };
  });
  const sm = getServiceManager({ platform: 'linux', unitPath: '/x', spawn });
  await expect(sm.ensureRegistered()).rejects.toThrow(/reload broken/);
});

test('ensureRegistered surfaces stderr when enable fails', async () => {
  const { spawn } = mockSpawn((argv) => {
    if (argv[2] === 'daemon-reload') return { exitCode: 0 };
    if (argv[2] === 'is-enabled') return { exitCode: 1 };
    if (argv[2] === 'enable') return { exitCode: 5, stderr: 'enable broken' };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({ platform: 'linux', unitPath: '/x', spawn });
  await expect(sm.ensureRegistered()).rejects.toThrow(/enable broken/);
});

test('start surfaces stderr when daemon-reload fails', async () => {
  const { spawn } = mockSpawn((argv) => {
    if (argv[2] === 'daemon-reload') return { exitCode: 6, stderr: 'reload-fail' };
    return { exitCode: 0 };
  });
  const sm = getServiceManager({ platform: 'linux', unitPath: '/x', spawn });
  await expect(sm.start()).rejects.toThrow(/reload-fail/);
});

test('start enables unit and surfaces stderr when enable fails', async () => {
  const { spawn } = mockSpawn((argv) => {
    if (argv[2] === 'daemon-reload') return { exitCode: 0 };
    if (argv[2] === 'is-enabled') return { exitCode: 1 };
    if (argv[2] === 'enable') return { exitCode: 4, stderr: 'unit-disabled' };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({ platform: 'linux', unitPath: '/x', spawn });
  await expect(sm.start()).rejects.toThrow(/unit-disabled/);
});

test('start surfaces stderr when start fails', async () => {
  const { spawn } = mockSpawn((argv) => {
    if (argv[2] === 'daemon-reload') return { exitCode: 0 };
    if (argv[2] === 'is-enabled') return { exitCode: 0 };
    if (argv[2] === 'start') return { exitCode: 3, stderr: 'cannot-start' };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({ platform: 'linux', unitPath: '/x', spawn });
  await expect(sm.start()).rejects.toThrow(/cannot-start/);
});

test('restart surfaces stderr when daemon-reload fails', async () => {
  const { spawn } = mockSpawn((argv) => {
    if (argv[2] === 'daemon-reload') return { exitCode: 6, stderr: 'reload-fail' };
    return { exitCode: 0 };
  });
  const sm = getServiceManager({ platform: 'linux', unitPath: '/x', spawn });
  await expect(sm.restart()).rejects.toThrow(/reload-fail/);
});

test('restart enables unit when not enabled and surfaces enable failure', async () => {
  const { spawn } = mockSpawn((argv) => {
    if (argv[2] === 'daemon-reload') return { exitCode: 0 };
    if (argv[2] === 'is-enabled') return { exitCode: 1 };
    if (argv[2] === 'enable') return { exitCode: 5, stderr: 'enable-broken' };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({ platform: 'linux', unitPath: '/x', spawn });
  await expect(sm.restart()).rejects.toThrow(/enable-broken/);
});

test('restart surfaces stderr when restart command fails', async () => {
  const { spawn } = mockSpawn((argv) => {
    if (argv[2] === 'daemon-reload') return { exitCode: 0 };
    if (argv[2] === 'is-enabled') return { exitCode: 0 };
    if (argv[2] === 'restart') return { exitCode: 7, stderr: 'restart-fail' };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({ platform: 'linux', unitPath: '/x', spawn });
  await expect(sm.restart()).rejects.toThrow(/restart-fail/);
});

test('start runs enable then start when unit is not yet enabled', async () => {
  const argvSeq: string[] = [];
  const { spawn } = mockSpawn((argv) => {
    argvSeq.push(argv[2] ?? '');
    if (argv[2] === 'daemon-reload') return { exitCode: 0 };
    if (argv[2] === 'is-enabled') return { exitCode: 1 };
    if (argv[2] === 'enable') return { exitCode: 0 };
    if (argv[2] === 'start') return { exitCode: 0 };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({ platform: 'linux', unitPath: '/x', spawn });
  await sm.start();
  expect(argvSeq).toEqual(['daemon-reload', 'is-enabled', 'enable', 'start']);
});

test('restart runs enable then restart when unit is not yet enabled', async () => {
  const argvSeq: string[] = [];
  const { spawn } = mockSpawn((argv) => {
    argvSeq.push(argv[2] ?? '');
    if (argv[2] === 'daemon-reload') return { exitCode: 0 };
    if (argv[2] === 'is-enabled') return { exitCode: 1 };
    if (argv[2] === 'enable') return { exitCode: 0 };
    if (argv[2] === 'restart') return { exitCode: 0 };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({ platform: 'linux', unitPath: '/x', spawn });
  await sm.restart();
  expect(argvSeq).toEqual(['daemon-reload', 'is-enabled', 'enable', 'restart']);
});

test('errors fall back to stdout when stderr is empty', async () => {
  const { spawn } = mockSpawn(() => ({
    exitCode: 5,
    stderr: '   ',
    stdout: 'stdout-fallback-message',
  }));
  const sm = getServiceManager({ platform: 'linux', unitPath: '/x', spawn });
  await expect(sm.stop()).rejects.toThrow(/stdout-fallback-message/);
});

test('unregister disables unit and reloads daemon', async () => {
  const argvSeq: string[] = [];
  const { spawn, invocations } = mockSpawn((argv) => {
    argvSeq.push(argv[2] ?? '');
    if (argv[2] === 'is-enabled') return { exitCode: 0 };
    if (argv[2] === 'disable') return { exitCode: 0 };
    if (argv[2] === 'daemon-reload') return { exitCode: 0 };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({ platform: 'linux', unitPath: '/x', spawn });
  await sm.unregister();
  expect(argvSeq).toEqual(['is-enabled', 'disable', 'daemon-reload']);
  expect(invocations.some((i) => i.argv[2] === 'disable')).toBe(true);
});

test('unregister skips disable when unit is already not enabled', async () => {
  const { spawn, invocations } = mockSpawn((argv) => {
    if (argv[2] === 'is-enabled') return { exitCode: 1 };
    if (argv[2] === 'daemon-reload') return { exitCode: 0 };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({ platform: 'linux', unitPath: '/x', spawn });
  await sm.unregister();
  expect(invocations.some((i) => i.argv[2] === 'disable')).toBe(false);
});

test('unregister surfaces stderr when disable fails', async () => {
  const { spawn } = mockSpawn((argv) => {
    if (argv[2] === 'is-enabled') return { exitCode: 0 };
    if (argv[2] === 'disable') return { exitCode: 5, stderr: 'disable-broken' };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({ platform: 'linux', unitPath: '/x', spawn });
  await expect(sm.unregister()).rejects.toThrow(/disable-broken/);
});

test('unregister surfaces stderr when daemon-reload fails', async () => {
  const { spawn } = mockSpawn((argv) => {
    if (argv[2] === 'is-enabled') return { exitCode: 1 };
    if (argv[2] === 'daemon-reload') return { exitCode: 6, stderr: 'reload-broken' };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({ platform: 'linux', unitPath: '/x', spawn });
  await expect(sm.unregister()).rejects.toThrow(/reload-broken/);
});

test('runtimeInfo extracts MainPID and ActiveEnterTimestamp', async () => {
  const { spawn } = mockSpawn(() => ({
    exitCode: 0,
    stdout: 'MainPID=2345\nActiveEnterTimestamp=Thu 2026-05-08 13:25:42 UTC\n',
  }));
  const sm = getServiceManager({ platform: 'linux', unitPath: '/u', spawn });
  const info = await sm.runtimeInfo();
  expect(info.pid).toBe(2345);
  expect(info.startedAt).not.toBeNull();
});

test('runtimeInfo returns nulls when systemctl show fails', async () => {
  const { spawn } = mockSpawn(() => ({ exitCode: 1, stdout: '' }));
  const sm = getServiceManager({ platform: 'linux', unitPath: '/u', spawn });
  const info = await sm.runtimeInfo();
  expect(info.pid).toBeNull();
  expect(info.startedAt).toBeNull();
});

test('parseSystemctlShow handles MainPID=0 (not running) and missing timestamp', () => {
  expect(parseSystemctlShow('MainPID=0\nActiveEnterTimestamp=\n')).toEqual({
    pid: null,
    startedAt: null,
  });
});

test('parseSystemctlShow ignores garbage timestamps', () => {
  expect(parseSystemctlShow('MainPID=42\nActiveEnterTimestamp=garbage\n')).toEqual({
    pid: 42,
    startedAt: null,
  });
});

test('parseSystemctlShow returns null pid when MainPID line absent', () => {
  expect(parseSystemctlShow('ActiveEnterTimestamp=\n')).toEqual({ pid: null, startedAt: null });
});
