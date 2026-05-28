import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rmRecursive } from 'core/io/fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureServiceUnitExists, writeServiceUnit } from 'cli/service-unit/writer.ts';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-svc-unit-'));
});

afterEach(async () => {
  await rmRecursive(dir);
});

test('writeServiceUnit emits a launchd plist on darwin', async () => {
  const path = join(dir, 'co.proxai.gateway.plist');
  await writeServiceUnit({
    serviceUnitPath: path,
    programPath: '/usr/local/bin/proxai-gateway',
    platform: 'darwin',
  });
  const text = await readFile(path, 'utf8');
  expect(text).toContain('<plist');
  expect(text).toContain('/usr/local/bin/proxai-gateway');
});

test('writeServiceUnit emits a systemd unit on linux', async () => {
  const path = join(dir, 'proxai-gateway.service');
  await writeServiceUnit({
    serviceUnitPath: path,
    programPath: '/usr/local/bin/proxai-gateway',
    platform: 'linux',
  });
  const text = await readFile(path, 'utf8');
  expect(text).toContain('[Unit]');
  expect(text).toContain('/usr/local/bin/proxai-gateway');
});

test('writeServiceUnit emits a scheduled task XML on win32', async () => {
  const path = join(dir, 'proxai-gateway.xml');
  await writeServiceUnit({
    serviceUnitPath: path,
    programPath: 'C\\Program Files\\proxai\\proxai-gateway.exe',
    platform: 'win32',
    windowsUserId: 'DESKTOP-X\\onur',
  });
  const text = await readFile(path, 'utf16le');
  expect(text).toContain('<Task');
  expect(text).toContain('proxai-gateway.exe');
});

test('writeServiceUnit on win32 omits userId when not provided', async () => {
  const path = join(dir, 'proxai-gateway.xml');
  await writeServiceUnit({
    serviceUnitPath: path,
    programPath: 'C\\proxai-gateway.exe',
    platform: 'win32',
  });
  const text = await readFile(path, 'utf16le');
  expect(text).toContain('<Task');
});

test('ensureServiceUnitExists writes when missing', async () => {
  const path = join(dir, 'plist');
  let recreateFired = false;
  let writeCalled = false;
  const wrote = await ensureServiceUnitExists({
    config: {
      serviceUnitPath: path,
      programPath: '/tmp/bin',
      platform: 'darwin',
    },
    fileExists: async () => false,
    writer: async () => {
      writeCalled = true;
    },
    onRecreate: () => {
      recreateFired = true;
    },
  });
  expect(wrote).toBe(true);
  expect(writeCalled).toBe(true);
  expect(recreateFired).toBe(true);
});

test('ensureServiceUnitExists skips when present', async () => {
  let writeCalled = false;
  const wrote = await ensureServiceUnitExists({
    config: {
      serviceUnitPath: join(dir, 'plist'),
      programPath: '/tmp/bin',
      platform: 'darwin',
    },
    fileExists: async () => true,
    writer: async () => {
      writeCalled = true;
    },
  });
  expect(wrote).toBe(false);
  expect(writeCalled).toBe(false);
});

test('ensureServiceUnitExists threads windowsUserId to writer', async () => {
  let observedUserId: string | undefined;
  await ensureServiceUnitExists({
    config: {
      serviceUnitPath: join(dir, 'plist'),
      programPath: '/tmp/bin',
      platform: 'win32',
      windowsUserId: 'CORP\\jane',
    },
    fileExists: async () => false,
    writer: async (input) => {
      observedUserId = input.windowsUserId;
    },
  });
  expect(observedUserId).toBe('CORP\\jane');
});

test('ensureServiceUnitExists default fileExists returns false for absent path then writes', async () => {
  const path = join(dir, 'absent-plist');
  let written = false;
  await ensureServiceUnitExists({
    config: {
      serviceUnitPath: path,
      programPath: '/tmp/bin',
      platform: 'darwin',
    },
    writer: async () => {
      written = true;
    },
  });
  expect(written).toBe(true);
});

test('ensureServiceUnitExists default writer writes a real file when called without a writer mock', async () => {
  const path = join(dir, 'real-plist');
  const wrote = await ensureServiceUnitExists({
    config: {
      serviceUnitPath: path,
      programPath: '/tmp/bin',
      platform: 'darwin',
    },
  });
  expect(wrote).toBe(true);
  const text = await readFile(path, 'utf8');
  expect(text).toContain('<plist');
});

test('writeServiceUnit defaults to prod profile on darwin', async () => {
  const path = join(dir, 'default-profile.plist');
  await writeServiceUnit({
    serviceUnitPath: path,
    programPath: '/usr/local/bin/proxai-gateway',
    platform: 'darwin',
  });
  const text = await readFile(path, 'utf8');
  expect(text).toContain('<string>--profile</string>');
  expect(text).toContain('<string>prod</string>');
  expect(text).not.toContain('<string>dev</string>');
});

test('writeServiceUnit uses dev profile on darwin when specified', async () => {
  const path = join(dir, 'dev-profile.plist');
  await writeServiceUnit({
    serviceUnitPath: path,
    programPath: '/usr/local/bin/proxai-gateway',
    platform: 'darwin',
    profileName: 'dev',
  });
  const text = await readFile(path, 'utf8');
  expect(text).toContain('<string>--profile</string>');
  expect(text).toContain('<string>dev</string>');
});

test('writeServiceUnit defaults to prod profile on linux', async () => {
  const path = join(dir, 'default-profile.service');
  await writeServiceUnit({
    serviceUnitPath: path,
    programPath: '/usr/local/bin/proxai-gateway',
    platform: 'linux',
  });
  const text = await readFile(path, 'utf8');
  expect(text).toContain('--profile');
  expect(text).toContain('prod');
});

test('writeServiceUnit uses dev profile on linux when specified', async () => {
  const path = join(dir, 'dev-profile.service');
  await writeServiceUnit({
    serviceUnitPath: path,
    programPath: '/usr/local/bin/proxai-gateway',
    platform: 'linux',
    profileName: 'dev',
  });
  const text = await readFile(path, 'utf8');
  expect(text).toContain('--profile');
  expect(text).toContain('dev');
});

test('writeServiceUnit defaults to prod profile on win32', async () => {
  const path = join(dir, 'default-profile.xml');
  await writeServiceUnit({
    serviceUnitPath: path,
    programPath: 'C:\\proxai-gateway.exe',
    platform: 'win32',
  });
  const text = await readFile(path, 'utf16le');
  expect(text).toContain('--profile');
  expect(text).toContain('prod');
});

test('writeServiceUnit uses dev profile on win32 when specified', async () => {
  const path = join(dir, 'dev-profile.xml');
  await writeServiceUnit({
    serviceUnitPath: path,
    programPath: 'C:\\proxai-gateway.exe',
    platform: 'win32',
    profileName: 'dev',
  });
  const text = await readFile(path, 'utf16le');
  expect(text).toContain('--profile');
  expect(text).toContain('dev');
});

test('ensureServiceUnitExists threads profileName to writer', async () => {
  let observedArgs: readonly string[] | undefined;
  await ensureServiceUnitExists({
    config: {
      serviceUnitPath: join(dir, 'plist'),
      programPath: '/tmp/bin',
      platform: 'darwin',
      profileName: 'dev',
    },
    fileExists: async () => false,
    writer: async (input) => {
      observedArgs = input.programArgs;
    },
  });
  expect(observedArgs).toEqual(['run', '--profile', 'dev']);
});

test('ensureServiceUnitExists uses prod profile by default', async () => {
  let observedArgs: readonly string[] | undefined;
  await ensureServiceUnitExists({
    config: {
      serviceUnitPath: join(dir, 'plist'),
      programPath: '/tmp/bin',
      platform: 'darwin',
    },
    fileExists: async () => false,
    writer: async (input) => {
      observedArgs = input.programArgs;
    },
  });
  expect(observedArgs).toEqual(['run', '--profile', 'prod']);
});
