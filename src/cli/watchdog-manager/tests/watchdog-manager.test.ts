import { expect, test } from 'bun:test';
import { getWatchdogManager } from 'cli/watchdog-manager/index.ts';
import { mockSpawn } from 'cli/service-manager/tests/mock-spawn.ts';

test('getWatchdogManager returns noop when PROXAI_TEST_PROFILE_ROOT is set and spawn is omitted', async () => {
  const original = process.env['PROXAI_TEST_PROFILE_ROOT'];
  process.env['PROXAI_TEST_PROFILE_ROOT'] = '/tmp/test';
  try {
    const wm = getWatchdogManager({
      platform: 'darwin',
      profile: 'prod',
    });
    expect(await wm.isInstalled()).toBe(false);
    await wm.install();
    await wm.uninstall();
  } finally {
    if (original === undefined) {
      delete process.env['PROXAI_TEST_PROFILE_ROOT'];
    } else {
      process.env['PROXAI_TEST_PROFILE_ROOT'] = original;
    }
  }
});

test('darwin launchctl backend isInstalled true when print exits 0', async () => {
  const { spawn, invocations } = mockSpawn(() => ({ exitCode: 0 }));
  const wm = getWatchdogManager({
    platform: 'darwin',
    profile: 'prod',
    spawn,
    label: 'co.test.label',
    plistPath: '/path/plist',
  });
  expect(await wm.isInstalled()).toBe(true);
  expect(invocations[0]?.argv).toContain('print');
});

test('darwin launchctl backend isInstalled false when print exits non-zero', async () => {
  const { spawn } = mockSpawn(() => ({ exitCode: 1 }));
  const wm = getWatchdogManager({
    platform: 'darwin',
    profile: 'prod',
    spawn,
    label: 'co.test.label',
    plistPath: '/path/plist',
  });
  expect(await wm.isInstalled()).toBe(false);
});

test('darwin launchctl backend install calls bootstrap when not loaded', async () => {
  const { spawn, invocations } = mockSpawn((argv) => {
    if (argv.includes('print')) return { exitCode: 1 };
    return { exitCode: 0 };
  });
  const wm = getWatchdogManager({
    platform: 'darwin',
    profile: 'prod',
    spawn,
    label: 'co.test.label',
    plistPath: '/path/plist',
  });
  await wm.install();
  expect(invocations.some((i) => i.argv.includes('bootstrap'))).toBe(true);
});

test('darwin launchctl backend uninstall calls bootout when loaded', async () => {
  const { spawn, invocations } = mockSpawn((argv) => {
    if (argv.includes('print')) return { exitCode: 0 };
    return { exitCode: 0 };
  });
  const wm = getWatchdogManager({
    platform: 'darwin',
    profile: 'prod',
    spawn,
    label: 'co.test.label',
    plistPath: '/path/plist',
  });
  await wm.uninstall();
  expect(invocations.some((i) => i.argv.includes('bootout'))).toBe(true);
});

test('linux systemctl backend isInstalled true when list-unit-files output contains timer', async () => {
  const { spawn } = mockSpawn(() => ({
    exitCode: 0,
    stdout: 'proxai-gateway-watchdog.timer enabled',
  }));
  const wm = getWatchdogManager({
    platform: 'linux',
    profile: 'prod',
    spawn,
    timerName: 'proxai-gateway-watchdog.timer',
  });
  expect(await wm.isInstalled()).toBe(true);
});

test('linux systemctl backend install calls reload and enable now', async () => {
  const { spawn, invocations } = mockSpawn(() => ({ exitCode: 0 }));
  const wm = getWatchdogManager({
    platform: 'linux',
    profile: 'prod',
    spawn,
    timerName: 'proxai-gateway-watchdog.timer',
  });
  await wm.install();
  expect(invocations[0]?.argv).toContain('daemon-reload');
  expect(invocations[1]?.argv).toContain('enable');
  expect(invocations[1]?.argv).toContain('--now');
});

test('linux systemctl backend uninstall calls disable now and reload', async () => {
  const { spawn, invocations } = mockSpawn(() => ({ exitCode: 0 }));
  const wm = getWatchdogManager({
    platform: 'linux',
    profile: 'prod',
    spawn,
    timerName: 'proxai-gateway-watchdog.timer',
  });
  await wm.uninstall();
  expect(invocations[0]?.argv).toContain('disable');
  expect(invocations[0]?.argv).toContain('--now');
  expect(invocations[1]?.argv).toContain('daemon-reload');
});

test('windows schtasks backend isInstalled based on query exitCode', async () => {
  const { spawn: spawnTrue } = mockSpawn(() => ({ exitCode: 0 }));
  const wmTrue = getWatchdogManager({
    platform: 'win32',
    profile: 'prod',
    spawn: spawnTrue,
    taskName: 'ProxAI Gateway Watchdog',
    xmlPath: 'C:\\path\\xml',
  });
  expect(await wmTrue.isInstalled()).toBe(true);

  const { spawn: spawnFalse } = mockSpawn(() => ({ exitCode: 1 }));
  const wmFalse = getWatchdogManager({
    platform: 'win32',
    profile: 'prod',
    spawn: spawnFalse,
    taskName: 'ProxAI Gateway Watchdog',
    xmlPath: 'C:\\path\\xml',
  });
  expect(await wmFalse.isInstalled()).toBe(false);
});

test('windows schtasks backend install creates task with XML', async () => {
  const { spawn, invocations } = mockSpawn(() => ({ exitCode: 0 }));
  const wm = getWatchdogManager({
    platform: 'win32',
    profile: 'prod',
    spawn,
    taskName: 'ProxAI Gateway Watchdog',
    xmlPath: 'C:\\path\\xml',
  });
  await wm.install();
  expect(invocations[0]?.argv).toContain('/Create');
  expect(invocations[0]?.argv).toContain('ProxAI Gateway Watchdog');
  expect(invocations[0]?.argv).toContain('C:\\path\\xml');
});

test('windows schtasks backend uninstall deletes task only if query exits 0', async () => {
  const { spawn, invocations } = mockSpawn((argv) => {
    if (argv.includes('/Query')) return { exitCode: 0 };
    return { exitCode: 0 };
  });
  const wm = getWatchdogManager({
    platform: 'win32',
    profile: 'prod',
    spawn,
    taskName: 'ProxAI Gateway Watchdog',
    xmlPath: 'C:\\path\\xml',
  });
  await wm.uninstall();
  expect(invocations.some((i) => i.argv.includes('/Delete'))).toBe(true);
});

test('getWatchdogManager throws for unsupported platform', () => {
  const { spawn } = mockSpawn(() => ({ exitCode: 0 }));
  expect(() =>
    getWatchdogManager({
      platform: 'freebsd',
      profile: 'prod',
      spawn,
    }),
  ).toThrow(/unsupported platform/);
});

test('darwin launchctl install returns immediately if already loaded', async () => {
  const { spawn, invocations } = mockSpawn(() => ({ exitCode: 0 }));
  const wm = getWatchdogManager({
    platform: 'darwin',
    profile: 'prod',
    spawn,
    label: 'co.test.label',
    plistPath: '/path/plist',
  });
  await wm.install();
  expect(invocations.some((i) => i.argv.includes('bootstrap'))).toBe(false);
});

test('darwin launchctl install throws if bootstrap fails', async () => {
  const { spawn } = mockSpawn((argv) => {
    if (argv.includes('print')) return { exitCode: 1 };
    return { exitCode: 1, stderr: 'some error' };
  });
  const wm = getWatchdogManager({
    platform: 'darwin',
    profile: 'prod',
    spawn,
    label: 'co.test.label',
    plistPath: '/path/plist',
  });
  expect(wm.install()).rejects.toThrow(/launchctl bootstrap failed/);
});

test('darwin launchctl uninstall returns immediately if not loaded', async () => {
  const { spawn, invocations } = mockSpawn(() => ({ exitCode: 1 }));
  const wm = getWatchdogManager({
    platform: 'darwin',
    profile: 'prod',
    spawn,
    label: 'co.test.label',
    plistPath: '/path/plist',
  });
  await wm.uninstall();
  expect(invocations.some((i) => i.argv.includes('bootout'))).toBe(false);
});

test('darwin launchctl uninstall throws if bootout fails', async () => {
  const { spawn } = mockSpawn((argv) => {
    if (argv.includes('print')) return { exitCode: 0 };
    return { exitCode: 1, stderr: 'some error' };
  });
  const wm = getWatchdogManager({
    platform: 'darwin',
    profile: 'prod',
    spawn,
    label: 'co.test.label',
    plistPath: '/path/plist',
  });
  expect(wm.uninstall()).rejects.toThrow(/launchctl bootout failed/);
});

test('windows schtasks install throws if create fails', async () => {
  const { spawn } = mockSpawn(() => ({ exitCode: 1, stderr: 'some error' }));
  const wm = getWatchdogManager({
    platform: 'win32',
    profile: 'prod',
    spawn,
    taskName: 'ProxAI Gateway Watchdog',
    xmlPath: 'C:\\path\\xml',
  });
  expect(wm.install()).rejects.toThrow(/schtasks \/Create failed/);
});

test('windows schtasks uninstall returns immediately if query fails', async () => {
  const { spawn, invocations } = mockSpawn(() => ({ exitCode: 1 }));
  const wm = getWatchdogManager({
    platform: 'win32',
    profile: 'prod',
    spawn,
    taskName: 'ProxAI Gateway Watchdog',
    xmlPath: 'C:\\path\\xml',
  });
  await wm.uninstall();
  expect(invocations.some((i) => i.argv.includes('/Delete'))).toBe(false);
});

test('linux systemctl isInstalled returns false if list-unit-files fails', async () => {
  const { spawn } = mockSpawn(() => ({ exitCode: 1 }));
  const wm = getWatchdogManager({
    platform: 'linux',
    profile: 'prod',
    spawn,
    timerName: 'proxai-gateway-watchdog.timer',
  });
  expect(await wm.isInstalled()).toBe(false);
});

test('linux systemctl install throws if daemon-reload fails', async () => {
  const { spawn } = mockSpawn(() => ({ exitCode: 1, stderr: 'reload-fail' }));
  const wm = getWatchdogManager({
    platform: 'linux',
    profile: 'prod',
    spawn,
    timerName: 'proxai-gateway-watchdog.timer',
  });
  expect(wm.install()).rejects.toThrow(/systemctl daemon-reload failed/);
});

test('linux systemctl install throws if enable fails', async () => {
  const { spawn } = mockSpawn((argv) => {
    if (argv.includes('daemon-reload')) return { exitCode: 0 };
    return { exitCode: 1, stderr: 'enable-fail' };
  });
  const wm = getWatchdogManager({
    platform: 'linux',
    profile: 'prod',
    spawn,
    timerName: 'proxai-gateway-watchdog.timer',
  });
  expect(wm.install()).rejects.toThrow(/systemctl enable --now failed/);
});
