import { expect, test } from 'bun:test';

import { GatewayError } from 'core/utils';
import { readMachineUuid } from 'core/system';
import type {
  MachineUuidFileReader,
  MachineUuidSpawnFn,
  MachineUuidSpawnResult,
} from 'core/system';

function fakeSpawn(stdout: string, exitCode = 0): MachineUuidSpawnFn {
  return (_argv, _options) => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(stdout));
        controller.close();
      },
    });
    const result: MachineUuidSpawnResult = {
      exited: Promise.resolve(exitCode),
      stdout: stream,
      exitCode,
    };
    return result;
  };
}

function fakeFiles(map: Record<string, string>): (path: string) => MachineUuidFileReader {
  return (path) => ({
    exists: () => Promise.resolve(path in map),
    text: () => {
      const value = map[path];
      if (value === undefined) return Promise.reject(new Error(`no such file: ${path}`));
      return Promise.resolve(value);
    },
  });
}

// ---------- darwin ----------

const SAMPLE_IOREG_OUTPUT = `+-o Root  <class IORegistryEntry, id 0x100000100, retain 35>
  +-o J274APAP  <class IOPlatformExpertDevice, id 0x100000110, registered, matched, active, busy 0 (3 ms), retain 38>
    {
      "IOPlatformSerialNumber" = "C02ABCDE1234"
      "IOPlatformUUID" = "12345678-1234-5678-1234-567812345678"
      "manufacturer" = <"Apple Inc.">
    }
`;

test('darwin: parses IOPlatformUUID from ioreg output', async () => {
  const uuid = await readMachineUuid({
    platform: 'darwin',
    spawn: fakeSpawn(SAMPLE_IOREG_OUTPUT),
  });
  expect(uuid).toBe('12345678-1234-5678-1234-567812345678');
});

test('darwin: throws when ioreg output omits IOPlatformUUID', async () => {
  await expect(
    readMachineUuid({
      platform: 'darwin',
      spawn: fakeSpawn('+-o Root\n  no uuid here\n'),
    }),
  ).rejects.toThrow(GatewayError);
});

test('darwin: throws when ioreg exits non-zero', async () => {
  await expect(
    readMachineUuid({
      platform: 'darwin',
      spawn: fakeSpawn('', 1),
    }),
  ).rejects.toThrow(/ioreg exit/);
});

// ---------- linux ----------

test('linux: reads /etc/machine-id and trims whitespace', async () => {
  const uuid = await readMachineUuid({
    platform: 'linux',
    readFile: fakeFiles({ '/etc/machine-id': '  abcdef0123456789\n' }),
  });
  expect(uuid).toBe('abcdef0123456789');
});

test('linux: falls back to /var/lib/dbus/machine-id when /etc/machine-id missing', async () => {
  const uuid = await readMachineUuid({
    platform: 'linux',
    readFile: fakeFiles({ '/var/lib/dbus/machine-id': 'fallback-id\n' }),
  });
  expect(uuid).toBe('fallback-id');
});

test('linux: throws when no machine-id file exists', async () => {
  await expect(
    readMachineUuid({
      platform: 'linux',
      readFile: fakeFiles({}),
    }),
  ).rejects.toThrow(/linux/);
});

test('linux: throws when machine-id file is empty', async () => {
  await expect(
    readMachineUuid({
      platform: 'linux',
      readFile: fakeFiles({ '/etc/machine-id': '   \n' }),
    }),
  ).rejects.toThrow(/linux/);
});

// ---------- win32 ----------

const SAMPLE_REG_OUTPUT = `

HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography
    MachineGuid    REG_SZ    aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee

`;

test('win32: parses MachineGuid from reg query output', async () => {
  const uuid = await readMachineUuid({
    platform: 'win32',
    spawn: fakeSpawn(SAMPLE_REG_OUTPUT),
  });
  expect(uuid).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
});

test('win32: throws when reg output omits MachineGuid', async () => {
  await expect(
    readMachineUuid({
      platform: 'win32',
      spawn: fakeSpawn('SomeOtherKey    REG_SZ    not-a-guid\n'),
    }),
  ).rejects.toThrow(GatewayError);
});

test('win32: throws when reg exits non-zero', async () => {
  await expect(
    readMachineUuid({
      platform: 'win32',
      spawn: fakeSpawn('', 1),
    }),
  ).rejects.toThrow(/reg exit/);
});

// ---------- unsupported ----------

test('throws on unsupported platform', async () => {
  await expect(
    readMachineUuid({
      platform: 'aix' as NodeJS.Platform,
    }),
  ).rejects.toThrow(/aix/);
});
