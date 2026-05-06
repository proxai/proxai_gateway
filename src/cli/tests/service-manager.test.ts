import { expect, test } from 'bun:test';

import { getServiceManager, runCommand } from 'cli/service-manager.ts';
import type { SpawnFn } from 'cli/service-manager.ts';

interface SpawnInvocation {
  argv: string[];
}

interface MockResponse {
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

function mockSpawn(handler: (argv: string[]) => MockResponse): {
  spawn: SpawnFn;
  invocations: SpawnInvocation[];
} {
  const invocations: SpawnInvocation[] = [];
  const spawn: SpawnFn = (argv) => {
    invocations.push({ argv: [...argv] });
    const resp = handler(argv);
    const stdoutText = resp.stdout ?? '';
    const stderrText = resp.stderr ?? '';
    const stdoutStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(stdoutText));
        controller.close();
      },
    });
    const stderrStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(stderrText));
        controller.close();
      },
    });
    return {
      stdout: stdoutStream,
      stderr: stderrStream,
      exited: Promise.resolve(resp.exitCode),
      exitCode: resp.exitCode,
    };
  };
  return { spawn, invocations };
}

test('runCommand returns stdout, stderr, exit code', async () => {
  const { spawn } = mockSpawn(() => ({ exitCode: 0, stdout: 'hello', stderr: 'oops' }));
  const result = await runCommand(spawn, ['echo', 'hi']);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toBe('hello');
  expect(result.stderr).toBe('oops');
});

// ---------- macOS / launchctl ----------

test('darwin: isRegistered true when launchctl print exits 0', async () => {
  const { spawn, invocations } = mockSpawn(() => ({ exitCode: 0 }));
  const sm = getServiceManager({
    platform: 'darwin',
    unitPath: '/p.plist',
    programPath: '/p',
    spawn,
  });
  expect(await sm.isRegistered()).toBe(true);
  expect(invocations[0]?.argv[0]).toBe('launchctl');
  expect(invocations[0]?.argv[1]).toBe('print');
  expect(invocations[0]?.argv[2]).toContain('co.proxai.gateway');
});

test('darwin: isRegistered false when launchctl print exits non-zero', async () => {
  const { spawn } = mockSpawn(() => ({ exitCode: 1 }));
  const sm = getServiceManager({
    platform: 'darwin',
    unitPath: '/p.plist',
    programPath: '/p',
    spawn,
  });
  expect(await sm.isRegistered()).toBe(false);
});

test('darwin: isRunning true when state = running in stdout', async () => {
  const { spawn } = mockSpawn(() => ({ exitCode: 0, stdout: 'foo\n\tstate = running\n' }));
  const sm = getServiceManager({
    platform: 'darwin',
    unitPath: '/p.plist',
    programPath: '/p',
    spawn,
  });
  expect(await sm.isRunning()).toBe(true);
});

test('darwin: isRunning false when not running', async () => {
  const { spawn } = mockSpawn(() => ({ exitCode: 0, stdout: 'state = stopped' }));
  const sm = getServiceManager({
    platform: 'darwin',
    unitPath: '/p.plist',
    programPath: '/p',
    spawn,
  });
  expect(await sm.isRunning()).toBe(false);
});

test('darwin: ensureRegistered bootstraps when not registered', async () => {
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
    programPath: '/p',
    spawn,
  });
  await sm.ensureRegistered();
  expect(printCalls).toBe(1);
  const bootstrap = invocations.find((i) => i.argv[1] === 'bootstrap');
  expect(bootstrap?.argv[2]).toMatch(/^gui\/\d+$/);
  expect(bootstrap?.argv[3]).toBe('/x.plist');
});

test('darwin: start kicks the registered service', async () => {
  const { spawn, invocations } = mockSpawn((argv) => {
    if (argv[1] === 'print') return { exitCode: 0 };
    if (argv[1] === 'kickstart') return { exitCode: 0 };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'darwin',
    unitPath: '/x.plist',
    programPath: '/p',
    spawn,
  });
  await sm.start();
  expect(invocations.some((i) => i.argv[1] === 'kickstart')).toBe(true);
});

test('darwin: stop runs bootout when registered', async () => {
  const { spawn, invocations } = mockSpawn((argv) => {
    if (argv[1] === 'print') return { exitCode: 0 };
    if (argv[1] === 'bootout') return { exitCode: 0 };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'darwin',
    unitPath: '/x.plist',
    programPath: '/p',
    spawn,
  });
  await sm.stop();
  expect(invocations.some((i) => i.argv[1] === 'bootout')).toBe(true);
});

test('darwin: stop is no-op when not registered', async () => {
  const { spawn, invocations } = mockSpawn(() => ({ exitCode: 1 }));
  const sm = getServiceManager({
    platform: 'darwin',
    unitPath: '/x.plist',
    programPath: '/p',
    spawn,
  });
  await sm.stop();
  expect(invocations.some((i) => i.argv[1] === 'bootout')).toBe(false);
});

test('darwin: restart uses kickstart -k', async () => {
  const { spawn, invocations } = mockSpawn((argv) => {
    if (argv[1] === 'print') return { exitCode: 0 };
    if (argv[1] === 'kickstart') return { exitCode: 0 };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'darwin',
    unitPath: '/x.plist',
    programPath: '/p',
    spawn,
  });
  await sm.restart();
  const kick = invocations.find((i) => i.argv[1] === 'kickstart');
  expect(kick?.argv[2]).toBe('-k');
});

// ---------- Linux / systemctl ----------

test('linux: isRegistered true when list-unit-files exits 0 with unit name', async () => {
  const { spawn, invocations } = mockSpawn(() => ({
    exitCode: 0,
    stdout: 'UNIT FILE                STATE  PRESET\nproxai-gateway.service   enabled enabled\n',
  }));
  const sm = getServiceManager({
    platform: 'linux',
    unitPath: '/etc/systemd/user/proxai-gateway.service',
    programPath: '/p',
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

test('linux: isRegistered false when output empty', async () => {
  const { spawn } = mockSpawn(() => ({ exitCode: 0, stdout: '' }));
  const sm = getServiceManager({
    platform: 'linux',
    unitPath: '/x',
    programPath: '/p',
    spawn,
  });
  expect(await sm.isRegistered()).toBe(false);
});

test('linux: isRunning true when is-active exits 0', async () => {
  const { spawn, invocations } = mockSpawn(() => ({ exitCode: 0, stdout: 'active' }));
  const sm = getServiceManager({
    platform: 'linux',
    unitPath: '/x',
    programPath: '/p',
    spawn,
  });
  expect(await sm.isRunning()).toBe(true);
  expect(invocations[0]?.argv).toEqual([
    'systemctl',
    '--user',
    'is-active',
    'proxai-gateway.service',
  ]);
});

test('linux: ensureRegistered runs daemon-reload then enable', async () => {
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
  const sm = getServiceManager({
    platform: 'linux',
    unitPath: '/x',
    programPath: '/p',
    spawn,
  });
  await sm.ensureRegistered();
  expect(enabledCalls).toBe(1);
  expect(invocations.some((i) => i.argv[2] === 'enable')).toBe(true);
});

test('linux: start runs systemctl start after ensure', async () => {
  const { spawn, invocations } = mockSpawn((argv) => {
    if (argv[2] === 'is-enabled') return { exitCode: 0 };
    return { exitCode: 0 };
  });
  const sm = getServiceManager({
    platform: 'linux',
    unitPath: '/x',
    programPath: '/p',
    spawn,
  });
  await sm.start();
  expect(invocations.some((i) => i.argv[2] === 'start')).toBe(true);
});

test('linux: stop runs systemctl stop', async () => {
  const { spawn, invocations } = mockSpawn(() => ({ exitCode: 0 }));
  const sm = getServiceManager({
    platform: 'linux',
    unitPath: '/x',
    programPath: '/p',
    spawn,
  });
  await sm.stop();
  expect(invocations[0]?.argv).toEqual(['systemctl', '--user', 'stop', 'proxai-gateway.service']);
});

test('linux: restart runs systemctl restart after ensure', async () => {
  const { spawn, invocations } = mockSpawn((argv) => {
    if (argv[2] === 'is-enabled') return { exitCode: 0 };
    return { exitCode: 0 };
  });
  const sm = getServiceManager({
    platform: 'linux',
    unitPath: '/x',
    programPath: '/p',
    spawn,
  });
  await sm.restart();
  expect(invocations.some((i) => i.argv[2] === 'restart')).toBe(true);
});

test('linux: surfaces stderr in error message when systemctl fails', async () => {
  const { spawn } = mockSpawn(() => ({ exitCode: 5, stderr: 'bad unit' }));
  const sm = getServiceManager({
    platform: 'linux',
    unitPath: '/x',
    programPath: '/p',
    spawn,
  });
  await expect(sm.stop()).rejects.toThrow(/bad unit/);
});

// ---------- Windows / schtasks ----------

test('win32: isRegistered true when schtasks /Query exits 0', async () => {
  const { spawn, invocations } = mockSpawn(() => ({ exitCode: 0 }));
  const sm = getServiceManager({
    platform: 'win32',
    unitPath: 'C:/x.xml',
    programPath: 'C:/p.exe',
    spawn,
  });
  expect(await sm.isRegistered()).toBe(true);
  expect(invocations[0]?.argv).toEqual(['schtasks', '/Query', '/TN', 'ProxAI Gateway']);
});

test('win32: isRegistered false when schtasks /Query exits non-zero', async () => {
  const { spawn } = mockSpawn(() => ({ exitCode: 1 }));
  const sm = getServiceManager({
    platform: 'win32',
    unitPath: 'C:/x.xml',
    programPath: 'C:/p.exe',
    spawn,
  });
  expect(await sm.isRegistered()).toBe(false);
});

test('win32: isRunning parses Status: Running from /FO LIST output', async () => {
  const { spawn, invocations } = mockSpawn(() => ({
    exitCode: 0,
    stdout: 'TaskName: ProxAI Gateway\r\nNext Run Time: N/A\r\nStatus:    Running\r\n',
  }));
  const sm = getServiceManager({
    platform: 'win32',
    unitPath: 'C:/x.xml',
    programPath: 'C:/p.exe',
    spawn,
  });
  expect(await sm.isRunning()).toBe(true);
  const lastArgv = invocations[0]?.argv;
  expect(lastArgv).toContain('/FO');
  expect(lastArgv).toContain('LIST');
});

test('win32: isRunning false when status is Ready', async () => {
  const { spawn } = mockSpawn(() => ({
    exitCode: 0,
    stdout: 'Status: Ready\r\n',
  }));
  const sm = getServiceManager({
    platform: 'win32',
    unitPath: 'C:/x.xml',
    programPath: 'C:/p.exe',
    spawn,
  });
  expect(await sm.isRunning()).toBe(false);
});

test('win32: ensureRegistered creates task with /XML when missing', async () => {
  const { spawn, invocations } = mockSpawn((argv) => {
    if (argv[1] === '/Query') return { exitCode: 1 };
    if (argv[1] === '/Create') return { exitCode: 0 };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'win32',
    unitPath: 'C:/Users/test/scheduled-task.xml',
    programPath: 'C:/p.exe',
    spawn,
  });
  await sm.ensureRegistered();
  const create = invocations.find((i) => i.argv[1] === '/Create');
  expect(create?.argv).toEqual([
    'schtasks',
    '/Create',
    '/TN',
    'ProxAI Gateway',
    '/XML',
    'C:/Users/test/scheduled-task.xml',
    '/F',
  ]);
});

test('win32: ensureRegistered no-op when already registered', async () => {
  let creates = 0;
  const { spawn } = mockSpawn((argv) => {
    if (argv[1] === '/Query') return { exitCode: 0 };
    if (argv[1] === '/Create') {
      creates++;
      return { exitCode: 0 };
    }
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'win32',
    unitPath: 'C:/x.xml',
    programPath: 'C:/p.exe',
    spawn,
  });
  await sm.ensureRegistered();
  expect(creates).toBe(0);
});

test('win32: start runs schtasks /Run after ensureRegistered', async () => {
  const { spawn, invocations } = mockSpawn((argv) => {
    if (argv[1] === '/Query') return { exitCode: 0 };
    if (argv[1] === '/Run') return { exitCode: 0 };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'win32',
    unitPath: 'C:/x.xml',
    programPath: 'C:/p.exe',
    spawn,
  });
  await sm.start();
  const run = invocations.find((i) => i.argv[1] === '/Run');
  expect(run?.argv).toEqual(['schtasks', '/Run', '/TN', 'ProxAI Gateway']);
});

test('win32: stop tolerates schtasks /End non-zero exit (task not running)', async () => {
  const { spawn, invocations } = mockSpawn(() => ({ exitCode: 1, stderr: 'task not running' }));
  const sm = getServiceManager({
    platform: 'win32',
    unitPath: 'C:/x.xml',
    programPath: 'C:/p.exe',
    spawn,
  });
  await sm.stop();
  expect(invocations[0]?.argv).toEqual(['schtasks', '/End', '/TN', 'ProxAI Gateway']);
});

test('win32: restart ends then runs', async () => {
  const calls: string[] = [];
  const { spawn } = mockSpawn((argv) => {
    if (argv[1] === '/Query') return { exitCode: 0 };
    calls.push(argv[1] ?? '');
    if (argv[1] === '/End') return { exitCode: 0 };
    if (argv[1] === '/Run') return { exitCode: 0 };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'win32',
    unitPath: 'C:/x.xml',
    programPath: 'C:/p.exe',
    spawn,
  });
  await sm.restart();
  expect(calls).toEqual(['/End', '/Run']);
});

test('win32: start surfaces stderr when /Run fails', async () => {
  const { spawn } = mockSpawn((argv) => {
    if (argv[1] === '/Query') return { exitCode: 0 };
    if (argv[1] === '/Run') return { exitCode: 9, stderr: 'access denied' };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'win32',
    unitPath: 'C:/x.xml',
    programPath: 'C:/p.exe',
    spawn,
  });
  await expect(sm.start()).rejects.toThrow(/access denied/);
});

test('unsupported platform throws clear error', () => {
  expect(() =>
    getServiceManager({
      platform: 'aix' as NodeJS.Platform,
      unitPath: '/x',
      programPath: '/p',
    }),
  ).toThrow(/unsupported platform/);
});

test('default spawn factory is wired up when deps.spawn is omitted', async () => {
  // Exercises the defaultSpawn() function — spawns a real command. Use the
  // current platform; isRegistered makes a single cheap query that returns a
  // boolean regardless of whether the service is registered.
  const sm = getServiceManager({
    platform: process.platform,
    unitPath: '/tmp/proxai-coverage-nonexistent.unit',
    programPath: '/usr/local/bin/proxai-gateway',
  });
  const result = await sm.isRegistered();
  expect(typeof result).toBe('boolean');
});

// ---------- darwin error branches ----------

test('darwin: ensureRegistered surfaces stderr when bootstrap fails', async () => {
  const { spawn } = mockSpawn((argv) => {
    if (argv[1] === 'print') return { exitCode: 1 };
    if (argv[1] === 'bootstrap') return { exitCode: 5, stderr: 'invalid plist' };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'darwin',
    unitPath: '/x.plist',
    programPath: '/p',
    spawn,
  });
  await expect(sm.ensureRegistered()).rejects.toThrow(/invalid plist/);
});

test('darwin: ensureRegistered falls back to stdout when stderr is empty', async () => {
  const { spawn } = mockSpawn((argv) => {
    if (argv[1] === 'print') return { exitCode: 1 };
    if (argv[1] === 'bootstrap')
      return { exitCode: 5, stderr: '   ', stdout: 'fallback-stdout-msg' };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'darwin',
    unitPath: '/x.plist',
    programPath: '/p',
    spawn,
  });
  await expect(sm.ensureRegistered()).rejects.toThrow(/fallback-stdout-msg/);
});

test('darwin: start bootstraps when not registered, then kicks', async () => {
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
    programPath: '/p',
    spawn,
  });
  await sm.start();
  expect(argvSeq).toEqual(['print', 'bootstrap', 'kickstart']);
});

test('darwin: start surfaces error when bootstrap fails before kickstart', async () => {
  const { spawn } = mockSpawn((argv) => {
    if (argv[1] === 'print') return { exitCode: 1 };
    if (argv[1] === 'bootstrap') return { exitCode: 9, stderr: 'plist locked' };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'darwin',
    unitPath: '/x.plist',
    programPath: '/p',
    spawn,
  });
  await expect(sm.start()).rejects.toThrow(/plist locked/);
});

test('darwin: start surfaces error when kickstart fails', async () => {
  const { spawn } = mockSpawn((argv) => {
    if (argv[1] === 'print') return { exitCode: 0 };
    if (argv[1] === 'kickstart') return { exitCode: 7, stderr: 'no such service' };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'darwin',
    unitPath: '/x.plist',
    programPath: '/p',
    spawn,
  });
  await expect(sm.start()).rejects.toThrow(/no such service/);
});

test('darwin: stop surfaces error when bootout fails', async () => {
  const { spawn } = mockSpawn((argv) => {
    if (argv[1] === 'print') return { exitCode: 0 };
    if (argv[1] === 'bootout') return { exitCode: 13, stderr: 'unable' };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'darwin',
    unitPath: '/x.plist',
    programPath: '/p',
    spawn,
  });
  await expect(sm.stop()).rejects.toThrow(/unable/);
});

test('darwin: restart bootstraps then kicks with -k when not registered', async () => {
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
    programPath: '/p',
    spawn,
  });
  await sm.restart();
  expect(argvSeq).toEqual(['print', 'bootstrap', 'kickstart/-k']);
});

test('darwin: restart surfaces error when bootstrap fails', async () => {
  const { spawn } = mockSpawn((argv) => {
    if (argv[1] === 'print') return { exitCode: 1 };
    if (argv[1] === 'bootstrap') return { exitCode: 4, stderr: 'oops' };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'darwin',
    unitPath: '/x.plist',
    programPath: '/p',
    spawn,
  });
  await expect(sm.restart()).rejects.toThrow(/oops/);
});

test('darwin: restart surfaces error when kickstart -k fails', async () => {
  const { spawn } = mockSpawn((argv) => {
    if (argv[1] === 'print') return { exitCode: 0 };
    if (argv[1] === 'kickstart') return { exitCode: 8, stderr: 'kick-failed' };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'darwin',
    unitPath: '/x.plist',
    programPath: '/p',
    spawn,
  });
  await expect(sm.restart()).rejects.toThrow(/kick-failed/);
});

// ---------- linux error branches ----------

test('linux: ensureRegistered surfaces stderr when daemon-reload fails', async () => {
  const { spawn } = mockSpawn((argv) => {
    if (argv[2] === 'daemon-reload') return { exitCode: 7, stderr: 'reload broken' };
    return { exitCode: 0 };
  });
  const sm = getServiceManager({
    platform: 'linux',
    unitPath: '/x',
    programPath: '/p',
    spawn,
  });
  await expect(sm.ensureRegistered()).rejects.toThrow(/reload broken/);
});

test('linux: ensureRegistered surfaces stderr when enable fails', async () => {
  const { spawn } = mockSpawn((argv) => {
    if (argv[2] === 'daemon-reload') return { exitCode: 0 };
    if (argv[2] === 'is-enabled') return { exitCode: 1 };
    if (argv[2] === 'enable') return { exitCode: 5, stderr: 'enable broken' };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'linux',
    unitPath: '/x',
    programPath: '/p',
    spawn,
  });
  await expect(sm.ensureRegistered()).rejects.toThrow(/enable broken/);
});

test('linux: start surfaces stderr when daemon-reload fails', async () => {
  const { spawn } = mockSpawn((argv) => {
    if (argv[2] === 'daemon-reload') return { exitCode: 6, stderr: 'reload-fail' };
    return { exitCode: 0 };
  });
  const sm = getServiceManager({
    platform: 'linux',
    unitPath: '/x',
    programPath: '/p',
    spawn,
  });
  await expect(sm.start()).rejects.toThrow(/reload-fail/);
});

test('linux: start enables unit and surfaces stderr when enable fails', async () => {
  const { spawn } = mockSpawn((argv) => {
    if (argv[2] === 'daemon-reload') return { exitCode: 0 };
    if (argv[2] === 'is-enabled') return { exitCode: 1 };
    if (argv[2] === 'enable') return { exitCode: 4, stderr: 'unit-disabled' };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'linux',
    unitPath: '/x',
    programPath: '/p',
    spawn,
  });
  await expect(sm.start()).rejects.toThrow(/unit-disabled/);
});

test('linux: start surfaces stderr when start fails', async () => {
  const { spawn } = mockSpawn((argv) => {
    if (argv[2] === 'daemon-reload') return { exitCode: 0 };
    if (argv[2] === 'is-enabled') return { exitCode: 0 };
    if (argv[2] === 'start') return { exitCode: 3, stderr: 'cannot-start' };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'linux',
    unitPath: '/x',
    programPath: '/p',
    spawn,
  });
  await expect(sm.start()).rejects.toThrow(/cannot-start/);
});

test('linux: restart surfaces stderr when daemon-reload fails', async () => {
  const { spawn } = mockSpawn((argv) => {
    if (argv[2] === 'daemon-reload') return { exitCode: 6, stderr: 'reload-fail' };
    return { exitCode: 0 };
  });
  const sm = getServiceManager({
    platform: 'linux',
    unitPath: '/x',
    programPath: '/p',
    spawn,
  });
  await expect(sm.restart()).rejects.toThrow(/reload-fail/);
});

test('linux: restart enables unit when not enabled and surfaces enable failure', async () => {
  const { spawn } = mockSpawn((argv) => {
    if (argv[2] === 'daemon-reload') return { exitCode: 0 };
    if (argv[2] === 'is-enabled') return { exitCode: 1 };
    if (argv[2] === 'enable') return { exitCode: 5, stderr: 'enable-broken' };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'linux',
    unitPath: '/x',
    programPath: '/p',
    spawn,
  });
  await expect(sm.restart()).rejects.toThrow(/enable-broken/);
});

test('linux: restart surfaces stderr when restart command fails', async () => {
  const { spawn } = mockSpawn((argv) => {
    if (argv[2] === 'daemon-reload') return { exitCode: 0 };
    if (argv[2] === 'is-enabled') return { exitCode: 0 };
    if (argv[2] === 'restart') return { exitCode: 7, stderr: 'restart-fail' };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'linux',
    unitPath: '/x',
    programPath: '/p',
    spawn,
  });
  await expect(sm.restart()).rejects.toThrow(/restart-fail/);
});

test('linux: start runs enable then start when unit is not yet enabled', async () => {
  const argvSeq: string[] = [];
  const { spawn } = mockSpawn((argv) => {
    argvSeq.push(argv[2] ?? '');
    if (argv[2] === 'daemon-reload') return { exitCode: 0 };
    if (argv[2] === 'is-enabled') return { exitCode: 1 };
    if (argv[2] === 'enable') return { exitCode: 0 };
    if (argv[2] === 'start') return { exitCode: 0 };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'linux',
    unitPath: '/x',
    programPath: '/p',
    spawn,
  });
  await sm.start();
  expect(argvSeq).toEqual(['daemon-reload', 'is-enabled', 'enable', 'start']);
});

test('linux: restart runs enable then restart when unit is not yet enabled', async () => {
  const argvSeq: string[] = [];
  const { spawn } = mockSpawn((argv) => {
    argvSeq.push(argv[2] ?? '');
    if (argv[2] === 'daemon-reload') return { exitCode: 0 };
    if (argv[2] === 'is-enabled') return { exitCode: 1 };
    if (argv[2] === 'enable') return { exitCode: 0 };
    if (argv[2] === 'restart') return { exitCode: 0 };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'linux',
    unitPath: '/x',
    programPath: '/p',
    spawn,
  });
  await sm.restart();
  expect(argvSeq).toEqual(['daemon-reload', 'is-enabled', 'enable', 'restart']);
});

test('linux: errors fall back to stdout when stderr is empty', async () => {
  const { spawn } = mockSpawn(() => ({
    exitCode: 5,
    stderr: '   ',
    stdout: 'stdout-fallback-message',
  }));
  const sm = getServiceManager({
    platform: 'linux',
    unitPath: '/x',
    programPath: '/p',
    spawn,
  });
  await expect(sm.stop()).rejects.toThrow(/stdout-fallback-message/);
});

// ---------- win32 error branches ----------

test('win32: ensureRegistered surfaces stderr when /Create fails', async () => {
  const { spawn } = mockSpawn((argv) => {
    if (argv[1] === '/Query') return { exitCode: 1 };
    if (argv[1] === '/Create') return { exitCode: 9, stderr: 'create-failed' };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'win32',
    unitPath: 'C:/x.xml',
    programPath: 'C:/p.exe',
    spawn,
  });
  await expect(sm.ensureRegistered()).rejects.toThrow(/create-failed/);
});

test('win32: start creates the task when missing and surfaces failure', async () => {
  const { spawn } = mockSpawn((argv) => {
    if (argv[1] === '/Query') return { exitCode: 1 };
    if (argv[1] === '/Create') return { exitCode: 4, stderr: 'create-failed' };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'win32',
    unitPath: 'C:/x.xml',
    programPath: 'C:/p.exe',
    spawn,
  });
  await expect(sm.start()).rejects.toThrow(/create-failed/);
});

test('win32: start succeeds when task missing then created', async () => {
  const argvSeq: string[] = [];
  const { spawn } = mockSpawn((argv) => {
    argvSeq.push(argv[1] ?? '');
    if (argv[1] === '/Query') return { exitCode: 1 };
    if (argv[1] === '/Create') return { exitCode: 0 };
    if (argv[1] === '/Run') return { exitCode: 0 };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'win32',
    unitPath: 'C:/x.xml',
    programPath: 'C:/p.exe',
    spawn,
  });
  await sm.start();
  expect(argvSeq).toEqual(['/Query', '/Create', '/Run']);
});

test('win32: restart creates task when missing and surfaces /Create failure', async () => {
  const { spawn } = mockSpawn((argv) => {
    if (argv[1] === '/Query') return { exitCode: 1 };
    if (argv[1] === '/Create') return { exitCode: 7, stderr: 'create-restart-failed' };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'win32',
    unitPath: 'C:/x.xml',
    programPath: 'C:/p.exe',
    spawn,
  });
  await expect(sm.restart()).rejects.toThrow(/create-restart-failed/);
});

test('win32: restart creates task when missing then ends and runs', async () => {
  const argvSeq: string[] = [];
  const { spawn } = mockSpawn((argv) => {
    argvSeq.push(argv[1] ?? '');
    if (argv[1] === '/Query') return { exitCode: 1 };
    if (argv[1] === '/Create') return { exitCode: 0 };
    if (argv[1] === '/End') return { exitCode: 0 };
    if (argv[1] === '/Run') return { exitCode: 0 };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'win32',
    unitPath: 'C:/x.xml',
    programPath: 'C:/p.exe',
    spawn,
  });
  await sm.restart();
  expect(argvSeq).toEqual(['/Query', '/Create', '/End', '/Run']);
});

test('win32: restart surfaces /Run failure', async () => {
  const { spawn } = mockSpawn((argv) => {
    if (argv[1] === '/Query') return { exitCode: 0 };
    if (argv[1] === '/End') return { exitCode: 0 };
    if (argv[1] === '/Run') return { exitCode: 6, stderr: 'run-failed' };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'win32',
    unitPath: 'C:/x.xml',
    programPath: 'C:/p.exe',
    spawn,
  });
  await expect(sm.restart()).rejects.toThrow(/run-failed/);
});

test('win32: errors fall back to stdout when stderr is empty', async () => {
  const { spawn } = mockSpawn((argv) => {
    if (argv[1] === '/Query') return { exitCode: 1 };
    if (argv[1] === '/Create') return { exitCode: 5, stderr: '   ', stdout: 'win-stdout-fallback' };
    return { exitCode: 1 };
  });
  const sm = getServiceManager({
    platform: 'win32',
    unitPath: 'C:/x.xml',
    programPath: 'C:/p.exe',
    spawn,
  });
  await expect(sm.ensureRegistered()).rejects.toThrow(/win-stdout-fallback/);
});
