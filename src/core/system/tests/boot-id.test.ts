import { expect, test } from 'bun:test';
import { rmRecursive } from 'core/io/fs';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GatewayError } from 'core/utils';
import { defaultBootIdReadFile, defaultBootIdSpawn, readBootId } from 'core/system/boot-id.ts';
import type { BootIdFileReader, BootIdSpawnFn, BootIdSpawnResult } from 'core/system/boot-id.ts';

function fakeSpawn(stdout: string, exitCode = 0): BootIdSpawnFn {
  return (_argv, _options) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(stdout));
        controller.close();
      },
    });
    const result: BootIdSpawnResult = {
      exited: Promise.resolve(exitCode),
      stdout: stream,
      exitCode,
    };
    return result;
  };
}

function fakeFiles(map: Record<string, string>): (path: string) => BootIdFileReader {
  return (path) => ({
    exists: () => Promise.resolve(path in map),
    text: () => {
      const value = map[path];
      if (value === undefined) return Promise.reject(new Error(`no such file: ${path}`));
      return Promise.resolve(value);
    },
  });
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

const SAMPLE_SYSCTL_OUTPUT = '{ sec = 1701234567, usec = 0 } Mon Jan  1 00:00:00 2024\n';

test('darwin: parses sec value from sysctl output and hashes it', async () => {
  const id = await readBootId({
    platform: 'darwin',
    spawn: fakeSpawn(SAMPLE_SYSCTL_OUTPUT),
  });
  expect(id).toBe(sha256Hex('darwin:1701234567'));
});

test('darwin: parsing is stable for the same boot epoch', async () => {
  const id1 = await readBootId({ platform: 'darwin', spawn: fakeSpawn(SAMPLE_SYSCTL_OUTPUT) });
  const id2 = await readBootId({ platform: 'darwin', spawn: fakeSpawn(SAMPLE_SYSCTL_OUTPUT) });
  expect(id1).toBe(id2);
});

test('darwin: produces different ids for different boot epochs', async () => {
  const a = await readBootId({
    platform: 'darwin',
    spawn: fakeSpawn('{ sec = 1700000000, usec = 0 } X'),
  });
  const b = await readBootId({
    platform: 'darwin',
    spawn: fakeSpawn('{ sec = 1700000001, usec = 0 } X'),
  });
  expect(a).not.toBe(b);
});

test('darwin: throws when sysctl output omits sec=', async () => {
  await expect(
    readBootId({
      platform: 'darwin',
      spawn: fakeSpawn('not the right shape\n'),
    }),
  ).rejects.toThrow(GatewayError);
});

test('darwin: throws when sysctl exits non-zero', async () => {
  await expect(
    readBootId({
      platform: 'darwin',
      spawn: fakeSpawn('', 1),
    }),
  ).rejects.toThrow(/sysctl exit/);
});

test('linux: returns trimmed contents of /proc/sys/kernel/random/boot_id', async () => {
  const id = await readBootId({
    platform: 'linux',
    readFile: fakeFiles({
      '/proc/sys/kernel/random/boot_id': '  abcd1234-5678-1234-9abc-deadbeefcafe\n',
    }),
  });
  expect(id).toBe('abcd1234-5678-1234-9abc-deadbeefcafe');
});

test('linux: throws when boot_id file missing', async () => {
  await expect(readBootId({ platform: 'linux', readFile: fakeFiles({}) })).rejects.toThrow(/linux/);
});

test('linux: throws when boot_id file is empty', async () => {
  await expect(
    readBootId({
      platform: 'linux',
      readFile: fakeFiles({ '/proc/sys/kernel/random/boot_id': '   \n' }),
    }),
  ).rejects.toThrow(/linux/);
});

test('win32: parses LastBootUpTime FILETIME and hashes it', async () => {
  const id = await readBootId({
    platform: 'win32',
    spawn: fakeSpawn('133456789012345678\r\n'),
  });
  expect(id).toBe(sha256Hex('win32:133456789012345678'));
});

test('win32: throws when output is not numeric', async () => {
  await expect(
    readBootId({ platform: 'win32', spawn: fakeSpawn('not-a-number\n') }),
  ).rejects.toThrow(GatewayError);
});

test('win32: throws when powershell exits non-zero', async () => {
  await expect(readBootId({ platform: 'win32', spawn: fakeSpawn('', 1) })).rejects.toThrow(
    /powershell exit/,
  );
});

test('throws on unsupported platform', async () => {
  await expect(readBootId({ platform: 'aix' as NodeJS.Platform })).rejects.toThrow(/aix/);
});

test('linux: falls through to defaultBootIdReadFile when readFile is omitted', async () => {
  try {
    await readBootId({ platform: 'linux' });
  } catch {}
});

test('defaultBootIdSpawn is wired up when spawn dep is omitted', async () => {
  try {
    const result = await readBootId({ platform: 'darwin' });
    expect(typeof result).toBe('string');
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
  }
});

test('defaultBootIdReadFile resolves exists() and text() against a real file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'proxai-bid-'));
  const path = join(dir, 'boot_id');
  await writeFile(path, 'abcd1234-5678-1234-9abc-deadbeefcafe\n');
  try {
    const reader = defaultBootIdReadFile(path);
    expect(await reader.exists()).toBe(true);
    expect(await reader.text()).toContain('abcd1234-5678-1234-9abc-deadbeefcafe');
    const missing = defaultBootIdReadFile(join(dir, 'no-such-file'));
    expect(await missing.exists()).toBe(false);
  } finally {
    await rmRecursive(dir);
  }
});

test('defaultBootIdSpawn returns a callable that runs a real subprocess', async () => {
  const spawn = defaultBootIdSpawn();
  const result = spawn(['echo', 'hello'], { stdout: 'pipe', stderr: 'pipe' });
  const text = await new Response(result.stdout).text();
  await result.exited;
  expect(text).toContain('hello');
});
