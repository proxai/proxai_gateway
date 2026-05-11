import { expect, test } from 'bun:test';

import { getServiceManager, parseLaunchctlPrint } from 'cli/service-manager';
import { mockSpawn } from 'cli/service-manager/tests/mock-spawn.ts';

test('isRegistered true when launchctl print exits 0', async () => {
  const { spawn, invocations } = mockSpawn(() => ({ exitCode: 0 }));
  const sm = getServiceManager({
    platform: 'darwin',
    unitPath: '/p.plist',
    spawn,
  });
  expect(await sm.isRegistered()).toBe(true);
  expect(invocations[0]?.argv[0]).toBe('launchctl');
  expect(invocations[0]?.argv[1]).toBe('print');
  expect(invocations[0]?.argv[2]).toContain('co.proxai.gateway');
});

test('isRegistered false when launchctl print exits non-zero', async () => {
  const { spawn } = mockSpawn(() => ({ exitCode: 1 }));
  const sm = getServiceManager({
    platform: 'darwin',
    unitPath: '/p.plist',
    spawn,
  });
  expect(await sm.isRegistered()).toBe(false);
});

test('isRunning true when state = running in stdout', async () => {
  const { spawn } = mockSpawn(() => ({ exitCode: 0, stdout: 'foo\n\tstate = running\n' }));
  const sm = getServiceManager({
    platform: 'darwin',
    unitPath: '/p.plist',
    spawn,
  });
  expect(await sm.isRunning()).toBe(true);
});

test('isRunning false when not running', async () => {
  const { spawn } = mockSpawn(() => ({ exitCode: 0, stdout: 'state = stopped' }));
  const sm = getServiceManager({
    platform: 'darwin',
    unitPath: '/p.plist',
    spawn,
  });
  expect(await sm.isRunning()).toBe(false);
});

test('ensureRegistered bootstraps when not registered', async () => {
  let printCalls = 0;
  const { spawn, invocations } = mockSpawn((argv) => {
    if (argv[1] === 'print') {
      printCalls++;
      return { exitCode: 1 };
    }
    if (argv[1] === 'bootstrap') return { exitCode: 0 };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'darwin',
    unitPath: '/x.plist',
    spawn,
  });
  await sm.ensureRegistered();
  expect(printCalls).toBe(1);
  const bootstrap = invocations.find((i) => i.argv[1] === 'bootstrap');
  expect(bootstrap?.argv[2]).toMatch(/^gui\/\d+$/);
  expect(bootstrap?.argv[3]).toBe('/x.plist');
});

test('start kicks the registered service', async () => {
  const { spawn, invocations } = mockSpawn((argv) => {
    if (argv[1] === 'print') return { exitCode: 0 };
    if (argv[1] === 'kickstart') return { exitCode: 0 };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'darwin',
    unitPath: '/x.plist',
    spawn,
  });
  await sm.start();
  expect(invocations.some((i) => i.argv[1] === 'kickstart')).toBe(true);
});

test('stop runs bootout when registered', async () => {
  const { spawn, invocations } = mockSpawn((argv) => {
    if (argv[1] === 'print') return { exitCode: 0 };
    if (argv[1] === 'bootout') return { exitCode: 0 };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'darwin',
    unitPath: '/x.plist',
    spawn,
  });
  await sm.stop();
  expect(invocations.some((i) => i.argv[1] === 'bootout')).toBe(true);
});

test('stop is no-op when not registered', async () => {
  const { spawn, invocations } = mockSpawn(() => ({ exitCode: 1 }));
  const sm = getServiceManager({
    platform: 'darwin',
    unitPath: '/x.plist',
    spawn,
  });
  await sm.stop();
  expect(invocations.some((i) => i.argv[1] === 'bootout')).toBe(false);
});

test('restart uses kickstart -k', async () => {
  const { spawn, invocations } = mockSpawn((argv) => {
    if (argv[1] === 'print') return { exitCode: 0 };
    if (argv[1] === 'kickstart') return { exitCode: 0 };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'darwin',
    unitPath: '/x.plist',
    spawn,
  });
  await sm.restart();
  const kick = invocations.find((i) => i.argv[1] === 'kickstart');
  expect(kick?.argv[2]).toBe('-k');
});

test('ensureRegistered surfaces stderr when bootstrap fails', async () => {
  const { spawn } = mockSpawn((argv) => {
    if (argv[1] === 'print') return { exitCode: 1 };
    if (argv[1] === 'bootstrap') return { exitCode: 5, stderr: 'invalid plist' };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'darwin',
    unitPath: '/x.plist',
    spawn,
  });
  await expect(sm.ensureRegistered()).rejects.toThrow(/invalid plist/);
});

test('ensureRegistered falls back to stdout when stderr is empty', async () => {
  const { spawn } = mockSpawn((argv) => {
    if (argv[1] === 'print') return { exitCode: 1 };
    if (argv[1] === 'bootstrap')
      return { exitCode: 5, stderr: '   ', stdout: 'fallback-stdout-msg' };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'darwin',
    unitPath: '/x.plist',
    spawn,
  });
  await expect(sm.ensureRegistered()).rejects.toThrow(/fallback-stdout-msg/);
});

test('start bootstraps when not registered, then kicks', async () => {
  const argvSeq: string[] = [];
  const { spawn } = mockSpawn((argv) => {
    argvSeq.push(argv[1] ?? '');
    if (argv[1] === 'print') return { exitCode: 1 };
    if (argv[1] === 'bootstrap') return { exitCode: 0 };
    if (argv[1] === 'kickstart') return { exitCode: 0 };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'darwin',
    unitPath: '/x.plist',
    spawn,
  });
  await sm.start();
  expect(argvSeq).toEqual(['print', 'bootstrap', 'kickstart']);
});

test('start surfaces error when bootstrap fails before kickstart', async () => {
  const { spawn } = mockSpawn((argv) => {
    if (argv[1] === 'print') return { exitCode: 1 };
    if (argv[1] === 'bootstrap') return { exitCode: 9, stderr: 'plist locked' };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'darwin',
    unitPath: '/x.plist',
    spawn,
  });
  await expect(sm.start()).rejects.toThrow(/plist locked/);
});

test('start surfaces error when kickstart fails', async () => {
  const { spawn } = mockSpawn((argv) => {
    if (argv[1] === 'print') return { exitCode: 0 };
    if (argv[1] === 'kickstart') return { exitCode: 7, stderr: 'no such service' };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'darwin',
    unitPath: '/x.plist',
    spawn,
  });
  await expect(sm.start()).rejects.toThrow(/no such service/);
});

test('stop surfaces error when bootout fails', async () => {
  const { spawn } = mockSpawn((argv) => {
    if (argv[1] === 'print') return { exitCode: 0 };
    if (argv[1] === 'bootout') return { exitCode: 13, stderr: 'unable' };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'darwin',
    unitPath: '/x.plist',
    spawn,
  });
  await expect(sm.stop()).rejects.toThrow(/unable/);
});

test('restart bootstraps then kicks with -k when not registered', async () => {
  const argvSeq: string[] = [];
  const { spawn } = mockSpawn((argv) => {
    argvSeq.push((argv[1] ?? '') + (argv[2] === '-k' ? '/-k' : ''));
    if (argv[1] === 'print') return { exitCode: 1 };
    if (argv[1] === 'bootstrap') return { exitCode: 0 };
    if (argv[1] === 'kickstart') return { exitCode: 0 };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'darwin',
    unitPath: '/x.plist',
    spawn,
  });
  await sm.restart();
  expect(argvSeq).toEqual(['print', 'bootstrap', 'kickstart/-k']);
});

test('restart surfaces error when bootstrap fails', async () => {
  const { spawn } = mockSpawn((argv) => {
    if (argv[1] === 'print') return { exitCode: 1 };
    if (argv[1] === 'bootstrap') return { exitCode: 4, stderr: 'oops' };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'darwin',
    unitPath: '/x.plist',
    spawn,
  });
  await expect(sm.restart()).rejects.toThrow(/oops/);
});

test('restart surfaces error when kickstart -k fails', async () => {
  const { spawn } = mockSpawn((argv) => {
    if (argv[1] === 'print') return { exitCode: 0 };
    if (argv[1] === 'kickstart') return { exitCode: 8, stderr: 'kick-failed' };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'darwin',
    unitPath: '/x.plist',
    spawn,
  });
  await expect(sm.restart()).rejects.toThrow(/kick-failed/);
});

test('unregister runs bootout when registered', async () => {
  const { spawn, invocations } = mockSpawn((argv) => {
    if (argv[1] === 'print') return { exitCode: 0 };
    if (argv[1] === 'bootout') return { exitCode: 0 };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'darwin',
    unitPath: '/x.plist',
    spawn,
  });
  await sm.unregister();
  const bootout = invocations.find((i) => i.argv[1] === 'bootout');
  expect(bootout?.argv[2]).toMatch(/^gui\/\d+\/co\.proxai\.gateway$/);
});

test('unregister is no-op when not registered (idempotent)', async () => {
  const { spawn, invocations } = mockSpawn(() => ({ exitCode: 1 }));
  const sm = getServiceManager({
    platform: 'darwin',
    unitPath: '/x.plist',
    spawn,
  });
  await sm.unregister();
  expect(invocations.some((i) => i.argv[1] === 'bootout')).toBe(false);
});

test('unregister surfaces stderr when bootout fails', async () => {
  const { spawn } = mockSpawn((argv) => {
    if (argv[1] === 'print') return { exitCode: 0 };
    if (argv[1] === 'bootout') return { exitCode: 7, stderr: 'bootout-failed' };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'darwin',
    unitPath: '/x.plist',
    spawn,
  });
  await expect(sm.unregister()).rejects.toThrow(/bootout-failed/);
});

test('runtimeInfo extracts pid from launchctl print output', async () => {
  const { spawn } = mockSpawn(() => ({
    exitCode: 0,
    stdout: 'state = running\npid = 12345\n',
  }));
  const sm = getServiceManager({
    platform: 'darwin',
    unitPath: '/u.plist',
    spawn,
  });
  const info = await sm.runtimeInfo();
  expect(info.pid).toBe(12345);
});

test('runtimeInfo returns nulls when launchctl print fails', async () => {
  const { spawn } = mockSpawn(() => ({ exitCode: 1, stdout: '' }));
  const sm = getServiceManager({
    platform: 'darwin',
    unitPath: '/u.plist',
    spawn,
  });
  const info = await sm.runtimeInfo();
  expect(info.pid).toBeNull();
  expect(info.startedAt).toBeNull();
});

test('parseLaunchctlPrint returns null pid when missing', () => {
  expect(parseLaunchctlPrint('state = idle\n')).toEqual({ pid: null, startedAt: null });
});

test('parseLaunchctlPrint extracts startedAt from spawn ts epoch seconds', () => {
  const stdout = [
    'co.proxai.gateway = {',
    '\tstate = running',
    '\tspawn ts = 1715424737',
    '\tpid = 12345',
    '}',
  ].join('\n');
  const info = parseLaunchctlPrint(stdout);
  expect(info.pid).toBe(12345);
  expect(info.startedAt).not.toBeNull();
  expect(info.startedAt?.toISOString()).toBe(new Date(1715424737 * 1000).toISOString());
});

test('parseLaunchctlPrint extracts startedAt from start time = epoch seconds', () => {
  const stdout = ['co.proxai.gateway = {', '\tstart time = 1715424737', '\tpid = 99999', '}'].join(
    '\n',
  );
  const info = parseLaunchctlPrint(stdout);
  expect(info.pid).toBe(99999);
  expect(info.startedAt).not.toBeNull();
  expect(info.startedAt?.toISOString()).toBe(new Date(1715424737 * 1000).toISOString());
});

test('runtimeInfo includes startedAt parsed from launchctl print', async () => {
  const { spawn } = mockSpawn(() => ({
    exitCode: 0,
    stdout: 'state = running\nspawn ts = 1715424737\npid = 12345\n',
  }));
  const sm = getServiceManager({
    platform: 'darwin',
    unitPath: '/u.plist',
    spawn,
  });
  const info = await sm.runtimeInfo();
  expect(info.pid).toBe(12345);
  expect(info.startedAt).not.toBeNull();
});
