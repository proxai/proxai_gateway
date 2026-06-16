import { expect, test, mock } from 'bun:test';
import {
  watchdogLaunchdLabel,
  watchdogSystemdTimerName,
  watchdogSystemdServiceName,
  watchdogWindowsTaskName,
  watchdogLaunchdPlistPath,
  watchdogSystemdTimerPath,
  watchdogSystemdServicePath,
  defaultWatchdogScheduledTaskXmlPath,
} from 'cli/service-unit/watchdog-labels.ts';
import { buildWatchdogLaunchdPlist } from 'cli/service-unit/watchdog-launchd-plist.ts';
import {
  buildWatchdogSystemdService,
  buildWatchdogSystemdTimer,
} from 'cli/service-unit/watchdog-systemd-units.ts';
import { buildWatchdogScheduledTaskXml } from 'cli/service-unit/watchdog-scheduled-task-xml.ts';
import {
  ensureWatchdogUnitExists,
  writeWatchdogServiceUnit,
} from 'cli/service-unit/watchdog-writer.ts';

test('watchdog labels and names mapped correctly', () => {
  expect(watchdogLaunchdLabel('prod')).toBe('co.proxai.gateway.watchdog');
  expect(watchdogLaunchdLabel('dev')).toBe('co.proxai.gateway.dev.watchdog');
  expect(watchdogSystemdTimerName('prod')).toBe('proxai-gateway-watchdog.timer');
  expect(watchdogSystemdTimerName('dev')).toBe('proxai-gateway-dev-watchdog.timer');
  expect(watchdogSystemdServiceName('prod')).toBe('proxai-gateway-watchdog.service');
  expect(watchdogSystemdServiceName('dev')).toBe('proxai-gateway-dev-watchdog.service');
  expect(watchdogWindowsTaskName('prod')).toBe('ProxAI Gateway Watchdog');
  expect(watchdogWindowsTaskName('dev')).toBe('ProxAI Gateway (dev) Watchdog');
});

test('watchdog default paths constructed correctly', () => {
  const original = process.env['PROXAI_TEST_PROFILE_ROOT'];
  process.env['PROXAI_TEST_PROFILE_ROOT'] = '/tmp/test';
  try {
    expect(watchdogLaunchdPlistPath('prod')).toBe(
      '/tmp/test/Library/LaunchAgents/co.proxai.gateway.watchdog.plist',
    );
    expect(watchdogSystemdTimerPath('prod')).toBe(
      '/tmp/test/.config/systemd/user/proxai-gateway-watchdog.timer',
    );
    expect(watchdogSystemdServicePath('prod')).toBe(
      '/tmp/test/.config/systemd/user/proxai-gateway-watchdog.service',
    );
    expect(defaultWatchdogScheduledTaskXmlPath('/tmp/test')).toBe(
      '/tmp/test/scheduled-task-watchdog.xml',
    );
  } finally {
    if (original === undefined) {
      delete process.env['PROXAI_TEST_PROFILE_ROOT'];
    } else {
      process.env['PROXAI_TEST_PROFILE_ROOT'] = original;
    }
  }
});

test('buildWatchdogLaunchdPlist structure', () => {
  const xml = buildWatchdogLaunchdPlist({
    programPath: '/bin/gateway',
    profile: 'prod',
  });
  expect(xml).toContain('<key>Label</key>');
  expect(xml).toContain('<string>co.proxai.gateway.watchdog</string>');
  expect(xml).toContain('<key>StartInterval</key>');
  expect(xml).toContain('<integer>900</integer>');
  expect(xml).toContain('<key>ProcessType</key>');
  expect(xml).toContain('<string>Background</string>');
  expect(xml).not.toContain('<key>KeepAlive</key>');
});

test('buildWatchdogSystemdService and Timer structure', () => {
  const svc = buildWatchdogSystemdService({
    programPath: '/bin/gateway',
    profile: 'prod',
  });
  expect(svc).toContain('Type=oneshot');
  expect(svc).toContain('ExecStart=/bin/gateway rescue --profile prod');
  expect(svc).toContain('TimeoutStartSec=120');

  const timer = buildWatchdogSystemdTimer({
    programPath: '/bin/gateway',
    profile: 'prod',
  });
  expect(timer).toContain('Unit=proxai-gateway-watchdog.service');
  expect(timer).toContain('OnBootSec=2min');
  expect(timer).toContain('OnUnitActiveSec=15min');
  expect(timer).toContain('AccuracySec=2min');
  expect(timer).toContain('Persistent=true');
  expect(timer).toContain('WantedBy=timers.target');
});

test('buildWatchdogScheduledTaskXml structure', () => {
  const xml = buildWatchdogScheduledTaskXml({
    programPath: 'C:\\bin\\gateway.exe',
    profile: 'prod',
  });
  expect(xml).toContain('<LogonType>S4U</LogonType>');
  expect(xml).toContain('<Interval>PT15M</Interval>');
  expect(xml).not.toContain('<Duration>');
  expect(xml).toContain('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>');
  expect(xml).toContain('<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>');
  expect(xml).toContain('<ExecutionTimeLimit>PT2M</ExecutionTimeLimit>');
  expect(xml).toContain('<Command>C:\\bin\\gateway.exe</Command>');
  expect(xml).toContain(
    '<Arguments>&quot;rescue&quot; &quot;--profile&quot; &quot;prod&quot;</Arguments>',
  );
});

test('ensureWatchdogUnitExists logic', async () => {
  const fileExistsMock = mock(() => Promise.resolve(false));
  const writerMock = mock(() => Promise.resolve());

  const result = await ensureWatchdogUnitExists({
    platform: 'darwin',
    profileName: 'prod',
    programPath: '/bin/gateway',
    plistPath: '/path/to/plist',
    fileExists: fileExistsMock,
    writer: writerMock,
  });

  expect(result).toBe(true);
  expect(fileExistsMock).toHaveBeenCalledTimes(1);
  expect(writerMock).toHaveBeenCalledTimes(1);

  const fileExistsTrueMock = mock(() => Promise.resolve(true));
  const resultExists = await ensureWatchdogUnitExists({
    platform: 'darwin',
    profileName: 'prod',
    programPath: '/bin/gateway',
    plistPath: '/path/to/plist',
    fileExists: fileExistsTrueMock,
    writer: writerMock,
  });
  expect(resultExists).toBe(false);
});

test('writeWatchdogServiceUnit for darwin, win32, linux', async () => {
  const { rm } = await import('node:fs/promises');
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { existsSync } = await import('node:fs');

  const dir = await mkdtemp(join(tmpdir(), 'proxai-watchdog-writer-'));
  try {
    const plistPath = join(dir, 'co.proxai.gateway.watchdog.plist');
    const xmlPath = join(dir, 'watchdog.xml');
    const timerPath = join(dir, 'watchdog.timer');
    const servicePath = join(dir, 'watchdog.service');

    await writeWatchdogServiceUnit({
      platform: 'darwin',
      profileName: 'prod',
      programPath: '/bin/gateway',
      plistPath,
    });
    expect(existsSync(plistPath)).toBe(true);

    await writeWatchdogServiceUnit({
      platform: 'win32',
      profileName: 'prod',
      programPath: 'C:\\bin\\gateway.exe',
      xmlPath,
    });
    expect(existsSync(xmlPath)).toBe(true);

    await writeWatchdogServiceUnit({
      platform: 'linux',
      profileName: 'prod',
      programPath: '/bin/gateway',
      timerPath,
      servicePath,
    });
    expect(existsSync(timerPath)).toBe(true);
    expect(existsSync(servicePath)).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writeWatchdogServiceUnit returning early when path undefined', async () => {
  await writeWatchdogServiceUnit({
    platform: 'darwin',
    profileName: 'prod',
    programPath: '/bin/gateway',
    plistPath: undefined,
  });
  await writeWatchdogServiceUnit({
    platform: 'win32',
    profileName: 'prod',
    programPath: '/bin/gateway',
    xmlPath: undefined,
  });
  await writeWatchdogServiceUnit({
    platform: 'linux',
    profileName: 'prod',
    programPath: '/bin/gateway',
    timerPath: undefined,
    servicePath: undefined,
  });
});

test('ensureWatchdogUnitExists undefined paths', async () => {
  const fileExistsMock = mock(() => Promise.resolve(false));
  const writerMock = mock(() => Promise.resolve());

  expect(
    await ensureWatchdogUnitExists({
      platform: 'darwin',
      profileName: 'prod',
      programPath: '/bin/gateway',
      plistPath: undefined,
      fileExists: fileExistsMock,
      writer: writerMock,
    }),
  ).toBe(false);

  expect(
    await ensureWatchdogUnitExists({
      platform: 'win32',
      profileName: 'prod',
      programPath: '/bin/gateway',
      xmlPath: undefined,
      fileExists: fileExistsMock,
      writer: writerMock,
    }),
  ).toBe(false);

  expect(
    await ensureWatchdogUnitExists({
      platform: 'linux',
      profileName: 'prod',
      programPath: '/bin/gateway',
      timerPath: undefined,
      servicePath: undefined,
      fileExists: fileExistsMock,
      writer: writerMock,
    }),
  ).toBe(false);
});

test('ensureWatchdogUnitExists win32 and linux paths', async () => {
  const fileExistsMock = mock(() => Promise.resolve(false));
  const writerMock = mock(() => Promise.resolve());

  expect(
    await ensureWatchdogUnitExists({
      platform: 'win32',
      profileName: 'prod',
      programPath: '/bin/gateway',
      xmlPath: '/path/xml',
      fileExists: fileExistsMock,
      writer: writerMock,
    }),
  ).toBe(true);

  expect(
    await ensureWatchdogUnitExists({
      platform: 'linux',
      profileName: 'prod',
      programPath: '/bin/gateway',
      timerPath: '/path/timer',
      servicePath: '/path/service',
      fileExists: fileExistsMock,
      writer: writerMock,
    }),
  ).toBe(true);

  const fileExistsTrueMock = mock(() => Promise.resolve(true));
  expect(
    await ensureWatchdogUnitExists({
      platform: 'win32',
      profileName: 'prod',
      programPath: '/bin/gateway',
      xmlPath: '/path/xml',
      fileExists: fileExistsTrueMock,
      writer: writerMock,
    }),
  ).toBe(false);

  expect(
    await ensureWatchdogUnitExists({
      platform: 'linux',
      profileName: 'prod',
      programPath: '/bin/gateway',
      timerPath: '/path/timer',
      servicePath: '/path/service',
      fileExists: fileExistsTrueMock,
      writer: writerMock,
    }),
  ).toBe(false);
});

test('ensureWatchdogUnitExists linux partial existence', async () => {
  let callCount = 0;
  const fileExistsPartialMock = mock(() => {
    callCount++;
    return Promise.resolve(callCount === 1);
  });
  const writerMock = mock(() => Promise.resolve());

  expect(
    await ensureWatchdogUnitExists({
      platform: 'linux',
      profileName: 'prod',
      programPath: '/bin/gateway',
      timerPath: '/path/timer',
      servicePath: '/path/service',
      fileExists: fileExistsPartialMock,
      writer: writerMock,
    }),
  ).toBe(true);

  callCount = 0;
  const fileExistsPartialMock2 = mock(() => {
    callCount++;
    return Promise.resolve(callCount === 2);
  });
  const writerMock2 = mock(() => Promise.resolve());

  expect(
    await ensureWatchdogUnitExists({
      platform: 'linux',
      profileName: 'prod',
      programPath: '/bin/gateway',
      timerPath: '/path/timer',
      servicePath: '/path/service',
      fileExists: fileExistsPartialMock2,
      writer: writerMock2,
    }),
  ).toBe(true);
});
