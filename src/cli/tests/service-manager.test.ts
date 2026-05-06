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

// ---------- Windows ----------

test('win32: throws "added in commit #3" placeholder error', async () => {
  const { spawn } = mockSpawn(() => ({ exitCode: 0 }));
  const sm = getServiceManager({
    platform: 'win32',
    unitPath: 'C:/x.xml',
    programPath: 'C:/p.exe',
    spawn,
  });
  await expect(sm.isRegistered()).rejects.toThrow(/commit #3/);
  await expect(sm.start()).rejects.toThrow(/commit #3/);
  await expect(sm.stop()).rejects.toThrow(/commit #3/);
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
