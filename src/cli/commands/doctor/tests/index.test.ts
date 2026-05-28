import { afterEach, beforeEach, expect, test } from 'bun:test';

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { requireDefined } from 'core/utils';
import { rmRecursive } from 'core/io/fs';
import { openBufferDb } from 'services/buffer';
import { runDoctor } from 'cli/commands/doctor/index.ts';
import { captureOutput } from 'cli/output.ts';
import type { OutputSink } from 'cli/cli.types.ts';
import type { DoctorCommandDeps } from 'cli/commands/doctor/doctor.types.ts';
import type { ServiceManager } from 'cli/service-manager';

let dir: string;
let bufferDbPath: string;

const origFetch = globalThis.fetch;
const origWhich = Bun.which;

function captured(): OutputSink & { lines: { level: string; msg: string }[] } {
  return captureOutput();
}

function stripAnsi(s: string): string {
  const ESC = String.fromCharCode(27);
  const ESC2 = String.fromCharCode(155);
  const ANSI_PATTERN = new RegExp(
    '[' + ESC + ESC2 + '][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]',
    'g',
  );
  return s.replace(ANSI_PATTERN, '');
}

function serviceManager(registered: boolean, running: boolean): ServiceManager {
  return {
    ensureRegistered: () => Promise.resolve(),
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    restart: () => Promise.resolve(),
    unregister: () => Promise.resolve(),
    isRegistered: () => Promise.resolve(registered),
    isRunning: () => Promise.resolve(running),
    runtimeInfo: () => Promise.resolve({ pid: null, startedAt: null }),
  };
}

function makeDeps(output: OutputSink, over: Partial<DoctorCommandDeps> = {}): DoctorCommandDeps {
  const base: DoctorCommandDeps = {
    output,
    bufferDbPath,
    configFilePath: join(dir, 'config.toml'),
    configDirPath: dir,
    logDirPath: dir,
    authFailedSentinelPath: join(dir, 'AUTH_FAILED'),
    bufferFullSentinelPath: join(dir, 'BUFFER_FULL'),
    sessionStoppedSentinelPath: join(dir, 'SESSION_STOPPED'),
    updateAvailableSentinelPath: join(dir, 'UPDATE_AVAILABLE'),
    nestVerifyKeyUrl: 'https://nest.example/verify',
    serviceManager: serviceManager(true, true),
    platform: 'linux',
    binaryPath: join(dir, 'binary'),
    currentVersion: '2026.5.28',
  };
  return { ...base, ...over };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-doctor-index-'));
  bufferDbPath = join(dir, 'buffer.db');
  const db = openBufferDb(bufferDbPath);
  db.close();
  globalThis.fetch = (() =>
    Promise.resolve(new Response('ok', { status: 200 }))) as unknown as typeof globalThis.fetch;
  (Bun as unknown as { which: typeof Bun.which }).which = (() => null) as typeof Bun.which;
});

afterEach(async () => {
  globalThis.fetch = origFetch;
  (Bun as unknown as { which: typeof Bun.which }).which = origWhich;
  await rmRecursive(dir);
});

test('runDoctor emits gathering banner and an output block, returns ok exit code', async () => {
  const out = captured();
  const result = await runDoctor(makeDeps(out), {});
  expect(result.exitCode).toBe(0);
  const joined = stripAnsi(out.lines.map((l) => l.msg).join('\n'));
  expect(joined).toContain('Gathering diagnostic signals...');
  expect(joined).toContain('=== proxai-gateway doctor ===');
});

test('healthy install with config + key + running daemon + source dir reports few criticals', async () => {
  await writeFile(join(dir, 'config.toml'), 'api_key = "secret"\n');
  await writeFile(join(dir, 'binary'), 'x');
  const out = captured();
  const result = await runDoctor(makeDeps(out, { serviceManager: serviceManager(true, true) }), {});
  expect(result.exitCode).toBe(0);
  const joined = stripAnsi(out.lines.map((l) => l.msg).join('\n'));
  expect(joined).toContain('=== proxai-gateway doctor ===');
});

test('multi-failure scenario surfaces several critical findings', async () => {
  await writeFile(join(dir, 'AUTH_FAILED'), '{}');
  const out = captured();
  const result = await runDoctor(
    makeDeps(out, {
      serviceManager: serviceManager(false, false),
      platform: 'linux',
    }),
    {},
  );
  expect(result.exitCode).toBe(0);
  const joined = stripAnsi(out.lines.map((l) => l.msg).join('\n'));
  expect(joined).toContain('CRITICAL');
  expect(joined).toContain('A1');
  expect(joined).toContain('B1');
});

test('accepts an explicit profile option without altering exit code', async () => {
  const out = captured();
  const result = await runDoctor(makeDeps(out), { profile: 'dev' });
  expect(result.exitCode).toBe(0);
  expect(requireDefined(out.lines[0]).msg).toContain('Gathering');
});
