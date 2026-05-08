import { expect, test } from 'bun:test';

import {
  createDefaultSweep,
  createSweep,
  isDirectBinary,
  parseBunPmLs,
  parseNpmLs,
  parsePnpmLs,
  parseYarnList,
  realCommandRunner,
} from 'cli/commands/uninstall-sweep.ts';
import type { CommandRunner } from 'cli/commands/uninstall-sweep.ts';

function fakeRunner(opts: {
  has?: Record<string, boolean>;
  exec?: Record<string, { stdout: string; ok: boolean }>;
  defaultExec?: { stdout: string; ok: boolean };
}): CommandRunner {
  return {
    has: async (cmd) => opts.has?.[cmd] ?? false,
    exec: async (file, args) => {
      const key = `${file} ${args.join(' ')}`;
      const v = opts.exec?.[key];
      if (v !== undefined) return v;
      return opts.defaultExec ?? { stdout: '', ok: false };
    },
  };
}

test('parseNpmLs detects package presence', () => {
  expect(
    parseNpmLs(JSON.stringify({ dependencies: { '@proxai/gateway': { version: '1' } } })),
  ).toBe(true);
  expect(parseNpmLs(JSON.stringify({ dependencies: { other: {} } }))).toBe(false);
  expect(parseNpmLs(JSON.stringify({}))).toBe(false);
  expect(parseNpmLs('not json')).toBe(false);
});

test('parsePnpmLs detects package presence in array form', () => {
  expect(
    parsePnpmLs(JSON.stringify([{ dependencies: { '@proxai/gateway': { version: '1' } } }])),
  ).toBe(true);
  expect(parsePnpmLs(JSON.stringify([{ dependencies: { other: {} } }]))).toBe(false);
  expect(parsePnpmLs(JSON.stringify([{}]))).toBe(false);
  expect(parsePnpmLs(JSON.stringify([]))).toBe(false);
  expect(parsePnpmLs(JSON.stringify({}))).toBe(false);
  expect(parsePnpmLs('garbage')).toBe(false);
  expect(parsePnpmLs(JSON.stringify([null]))).toBe(false);
});

test('parseYarnList scans json lines', () => {
  expect(parseYarnList('{"type":"info","data":"\\"@proxai/gateway@2026.5.9\\""}')).toBe(true);
  expect(parseYarnList('{"type":"info","data":"\\"other@1\\""}')).toBe(false);
  expect(parseYarnList('')).toBe(false);
});

test('parseBunPmLs detects substring', () => {
  expect(parseBunPmLs('├── @proxai/gateway@2026.5.9')).toBe(true);
  expect(parseBunPmLs('nothing here')).toBe(false);
});

test('isDirectBinary excludes node_modules and Cellar paths', () => {
  expect(isDirectBinary('/usr/local/bin/proxai-gateway')).toBe(true);
  expect(
    isDirectBinary('/Users/x/.nvm/.../lib/node_modules/@proxai/gateway/bin/proxai-gateway'),
  ).toBe(false);
  expect(isDirectBinary('C:\\Users\\x\\AppData\\node_modules\\proxai\\gateway\\bin\\app.exe')).toBe(
    false,
  );
  expect(isDirectBinary('/opt/homebrew/Cellar/proxai-gateway/2026.5.9/bin/proxai-gateway')).toBe(
    false,
  );
});

test('detectAll: marks unavailable PMs as not installed', async () => {
  const sweep = createSweep(fakeRunner({ has: {} }));
  const all = await sweep.detectAll();
  expect(all).toEqual([
    { name: 'npm', available: false, installed: false },
    { name: 'pnpm', available: false, installed: false },
    { name: 'yarn', available: false, installed: false },
    { name: 'bun', available: false, installed: false },
  ]);
});

test('detectAll: detects installed via npm', async () => {
  const sweep = createSweep(
    fakeRunner({
      has: { npm: true, pnpm: true, yarn: true, bun: true },
      exec: {
        'npm ls -g --depth=0 --json @proxai/gateway': {
          stdout: JSON.stringify({ dependencies: { '@proxai/gateway': { version: '1' } } }),
          ok: true,
        },
        'pnpm ls -g --depth=0 --json @proxai/gateway': {
          stdout: JSON.stringify([{ dependencies: {} }]),
          ok: true,
        },
        'yarn global list --json': { stdout: '', ok: true },
        'bun pm ls -g': { stdout: 'no proxai package here', ok: true },
      },
    }),
  );
  const all = await sweep.detectAll();
  expect(all.find((x) => x.name === 'npm')?.installed).toBe(true);
  expect(all.find((x) => x.name === 'pnpm')?.installed).toBe(false);
  expect(all.find((x) => x.name === 'yarn')?.installed).toBe(false);
  expect(all.find((x) => x.name === 'bun')?.installed).toBe(false);
});

test('detectAll: parses output even when exec returns non-zero (npm ls -g typically does)', async () => {
  const sweep = createSweep(
    fakeRunner({
      has: { npm: true },
      exec: {
        'npm ls -g --depth=0 --json @proxai/gateway': {
          stdout: JSON.stringify({ dependencies: { '@proxai/gateway': { version: '1' } } }),
          ok: false,
        },
      },
    }),
  );
  const all = await sweep.detectAll();
  expect(all.find((x) => x.name === 'npm')?.installed).toBe(true);
});

test('detectAll: empty output + non-zero exit → not installed', async () => {
  const sweep = createSweep(
    fakeRunner({
      has: { npm: true },
      exec: {
        'npm ls -g --depth=0 --json @proxai/gateway': { stdout: '', ok: false },
      },
    }),
  );
  const all = await sweep.detectAll();
  expect(all.find((x) => x.name === 'npm')?.installed).toBe(false);
});

test('uninstall: success path returns ok message', async () => {
  const sweep = createSweep(
    fakeRunner({
      exec: { 'npm uninstall -g @proxai/gateway': { stdout: 'removed', ok: true } },
    }),
  );
  expect(await sweep.uninstall('npm')).toEqual({ ok: true, message: 'removed via npm' });
});

test('uninstall: failure with stdout returns last line as detail', async () => {
  const sweep = createSweep(
    fakeRunner({
      exec: {
        'pnpm uninstall -g @proxai/gateway': { stdout: 'first line\nlast error here', ok: false },
      },
    }),
  );
  const r = await sweep.uninstall('pnpm');
  expect(r.ok).toBe(false);
  expect(r.message).toBe('pnpm uninstall failed: last error here');
});

test('uninstall: failure with empty stdout uses generic detail', async () => {
  const sweep = createSweep(
    fakeRunner({
      exec: { 'yarn global remove @proxai/gateway': { stdout: '', ok: false } },
    }),
  );
  const r = await sweep.uninstall('yarn');
  expect(r.ok).toBe(false);
  expect(r.message).toBe('yarn uninstall failed: non-zero exit');
});

test('uninstall: bun command path', async () => {
  const sweep = createSweep(
    fakeRunner({
      exec: { 'bun remove -g @proxai/gateway': { stdout: '', ok: true } },
    }),
  );
  expect(await sweep.uninstall('bun')).toEqual({ ok: true, message: 'removed via bun' });
});

test('detectBrew: not available', async () => {
  const sweep = createSweep(fakeRunner({ has: {} }));
  expect(await sweep.detectBrew()).toEqual({ available: false, installed: false });
});

test('detectBrew: available but not installed', async () => {
  const sweep = createSweep(
    fakeRunner({
      has: { brew: true },
      exec: { 'brew list --formula --versions proxai-gateway': { stdout: '', ok: false } },
    }),
  );
  expect(await sweep.detectBrew()).toEqual({ available: true, installed: false });
});

test('detectBrew: available and installed', async () => {
  const sweep = createSweep(
    fakeRunner({
      has: { brew: true },
      exec: {
        'brew list --formula --versions proxai-gateway': { stdout: 'proxai-gateway 1', ok: true },
      },
    }),
  );
  expect(await sweep.detectBrew()).toEqual({ available: true, installed: true });
});

test('uninstallBrew: success', async () => {
  const sweep = createSweep(
    fakeRunner({
      exec: { 'brew uninstall proxai-gateway': { stdout: 'uninstalled', ok: true } },
    }),
  );
  expect(await sweep.uninstallBrew()).toEqual({ ok: true, message: 'removed via brew' });
});

test('uninstallBrew: failure with stdout', async () => {
  const sweep = createSweep(
    fakeRunner({
      exec: { 'brew uninstall proxai-gateway': { stdout: 'oops\nbrew error', ok: false } },
    }),
  );
  const r = await sweep.uninstallBrew();
  expect(r.ok).toBe(false);
  expect(r.message).toBe('brew uninstall failed: brew error');
});

test('uninstallBrew: failure empty stdout', async () => {
  const sweep = createSweep(
    fakeRunner({
      exec: { 'brew uninstall proxai-gateway': { stdout: '', ok: false } },
    }),
  );
  const r = await sweep.uninstallBrew();
  expect(r.ok).toBe(false);
  expect(r.message).toBe('brew uninstall failed: non-zero exit');
});

test('createDefaultSweep returns a working sweep', () => {
  const sweep = createDefaultSweep();
  expect(typeof sweep.detectAll).toBe('function');
  expect(typeof sweep.uninstall).toBe('function');
  expect(typeof sweep.detectBrew).toBe('function');
  expect(typeof sweep.uninstallBrew).toBe('function');
});

test('realCommandRunner.has returns true for an existing executable', async () => {
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  expect(await realCommandRunner.has(lookup)).toBe(true);
});

test('realCommandRunner.has returns false for a nonexistent executable', async () => {
  expect(await realCommandRunner.has('__definitely_not_a_real_cmd_xyz_42__')).toBe(false);
});

test('realCommandRunner.exec returns ok=true for a successful command', async () => {
  const r = await realCommandRunner.exec(process.execPath, ['--version']);
  expect(r.ok).toBe(true);
  expect(r.stdout.length).toBeGreaterThan(0);
});

test('realCommandRunner.exec returns ok=false with captured stdout on failure', async () => {
  const r = await realCommandRunner.exec(process.execPath, [
    '-e',
    'process.stdout.write("hi"); process.exit(2)',
  ]);
  expect(r.ok).toBe(false);
  expect(r.stdout).toBe('hi');
});

test('realCommandRunner.exec returns ok=false with empty stdout on spawn error', async () => {
  const r = await realCommandRunner.exec('__definitely_not_a_real_cmd_xyz_42__', []);
  expect(r.ok).toBe(false);
  expect(r.stdout).toBe('');
});
