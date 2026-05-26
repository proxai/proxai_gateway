import { requireDefined } from 'core/utils';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createDefaultBinaryRemover,
  createPosixBinaryRemover,
  createWindowsBinaryRemover,
  realDetachedSpawn,
  type DetachedSpawn,
} from 'services/uninstall';

let tmpRoot: string;
beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'proxai-binremove-'));
});
afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

const throwingDetachedSpawn: DetachedSpawn = () => {
  throw new Error('CreateProcess failure');
};

test('posix remover: unlinks the file and rmdirs the install dir if empty', async () => {
  const installDir = join(tmpRoot, 'bin');
  await mkdir(installDir);
  const bin = join(installDir, 'proxai-gateway');
  await writeFile(bin, 'binary-bytes');
  const remover = createPosixBinaryRemover();
  const result = await remover.remove(bin, { installDir });
  expect(result.ok).toBe(true);
  expect(result.deferred).toBe(false);
  expect(result.message).toBe(`removed ${bin}`);
  expect(await Bun.file(bin).exists()).toBe(false);
  await expect(readdir(installDir)).rejects.toThrow();
});

test('posix remover: leaves install dir intact when other files remain', async () => {
  const installDir = join(tmpRoot, 'bin');
  await mkdir(installDir);
  const bin = join(installDir, 'proxai-gateway');
  await writeFile(bin, 'b');
  await writeFile(join(installDir, 'other'), 'leftover');
  const remover = createPosixBinaryRemover();
  await remover.remove(bin, { installDir });
  const remaining = await readdir(installDir);
  expect(remaining).toEqual(['other']);
});

test('posix remover: ENOENT on the binary returns ok with already-gone message', async () => {
  const installDir = join(tmpRoot, 'bin');
  await mkdir(installDir);
  const bin = join(installDir, 'proxai-gateway');
  const remover = createPosixBinaryRemover();
  const result = await remover.remove(bin);
  expect(result.ok).toBe(true);
  expect(result.message).toBe(`binary already gone: ${bin}`);
});

test('posix remover: non-ENOENT unlink failure returns ok=false with the underlying error', async () => {
  const remover = createPosixBinaryRemover({
    unlinkImpl: async () => {
      const err = new Error('EACCES open denied') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    },
  });
  const result = await remover.remove('/anything');
  expect(result.ok).toBe(false);
  expect(result.message).toContain('failed to remove binary at /anything');
  expect(result.message).toContain('EACCES');
});

test('posix remover: rmdir errors on installDir are swallowed', async () => {
  let rmdirCalled = false;
  const remover = createPosixBinaryRemover({
    unlinkImpl: async () => undefined,
    rmdirImpl: async () => {
      rmdirCalled = true;
      const err = new Error('ENOTEMPTY') as NodeJS.ErrnoException;
      err.code = 'ENOTEMPTY';
      throw err;
    },
  });
  const result = await remover.remove('/anything', { installDir: '/some/dir' });
  expect(result.ok).toBe(true);
  expect(rmdirCalled).toBe(true);
});

test('posix remover: skips rmdir when installDir is not provided', async () => {
  let rmdirCalled = false;
  const remover = createPosixBinaryRemover({
    unlinkImpl: async () => undefined,
    rmdirImpl: async () => {
      rmdirCalled = true;
    },
  });
  const result = await remover.remove('/anything');
  expect(result.ok).toBe(true);
  expect(rmdirCalled).toBe(false);
});

test('windows remover: schedules cmd /c with ping + del + del .new', async () => {
  let captured: { file: string; args: string[] } | undefined;
  const spawn: DetachedSpawn = (file, args) => {
    captured = { file, args };
  };
  const remover = createWindowsBinaryRemover({ spawnImpl: spawn });
  const result = await remover.remove('C:\\Users\\x\\.proxai\\bin\\proxai-gateway.exe');
  expect(result.ok).toBe(true);
  expect(result.deferred).toBe(true);
  expect(result.message).toContain('scheduled removal');
  expect(requireDefined(captured).file).toBe('cmd.exe');
  expect(requireDefined(captured).args[0]).toBe('/c');
  expect(requireDefined(captured).args[1]).toContain('ping -n 3 127.0.0.1');
  expect(requireDefined(captured).args[1]).toContain(
    'del /F /Q "C:\\Users\\x\\.proxai\\bin\\proxai-gateway.exe"',
  );
  expect(requireDefined(captured).args[1]).toContain(
    'del /F /Q "C:\\Users\\x\\.proxai\\bin\\proxai-gateway.exe.new"',
  );
});

test('windows remover: includes rmdir installDir 2>nul when installDir provided', async () => {
  let captured: { args: string[] } | undefined;
  const spawn: DetachedSpawn = (_file, args) => {
    captured = { args };
  };
  const remover = createWindowsBinaryRemover({ spawnImpl: spawn });
  await remover.remove('C:\\bin\\proxai.exe', { installDir: 'C:\\Users\\x\\.proxai\\bin' });
  expect(requireDefined(captured).args[1]).toContain('rmdir "C:\\Users\\x\\.proxai\\bin" 2>nul');
});

test('windows remover: omits rmdir fragment when installDir not provided', async () => {
  let captured: { args: string[] } | undefined;
  const spawn: DetachedSpawn = (_file, args) => {
    captured = { args };
  };
  const remover = createWindowsBinaryRemover({ spawnImpl: spawn });
  await remover.remove('C:\\bin\\proxai.exe');
  expect(requireDefined(captured).args[1]).not.toContain('rmdir');
});

test('windows remover: spawn throw is captured and surfaced as ok=false', async () => {
  const remover = createWindowsBinaryRemover({ spawnImpl: throwingDetachedSpawn });
  const result = await remover.remove('C:\\bin\\proxai.exe');
  expect(result.ok).toBe(false);
  expect(result.message).toContain('failed to schedule binary removal');
  expect(result.message).toContain('CreateProcess failure');
});

test('createDefaultBinaryRemover: returns windows variant on win32', () => {
  const remover = createDefaultBinaryRemover('win32');
  expect(typeof remover.remove).toBe('function');
});

test('createDefaultBinaryRemover: returns posix variant on darwin/linux', () => {
  expect(typeof createDefaultBinaryRemover('darwin').remove).toBe('function');
  expect(typeof createDefaultBinaryRemover('linux').remove).toBe('function');
});

test('realDetachedSpawn: invokes Bun.spawn fire-and-forget for a runnable binary', () => {
  const safe = process.platform === 'win32' ? 'cmd.exe' : '/usr/bin/true';
  expect(() => realDetachedSpawn(safe, [])).not.toThrow();
});
