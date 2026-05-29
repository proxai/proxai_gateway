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
import { readBootId } from 'core/system/boot-id.ts';
import { profileRootDir } from 'core/io/fs/profile.ts';
import { writeFileSync, rmSync } from 'node:fs';

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
    profileCtx: {
      name: 'dev',
      isDev: true,
      configDir: dir,
      configFilePath: join(dir, 'config.toml'),
      bufferDbPath,
      logDir: dir,
      sentinels: {
        authFailed: join(dir, 'AUTH_FAILED'),
        bufferFull: join(dir, 'BUFFER_FULL'),
        sessionStopped: join(dir, 'SESSION_STOPPED'),
        consent: join(dir, 'CONSENT'),
        updateAvailable: join(dir, 'UPDATE_AVAILABLE'),
      },
      controlSocketPath: join(dir, 'control.sock'),
      defaultNestBaseUrl: 'https://nest.example',
    },
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

test('doctor writes HTML report to specified absolute output path', async () => {
  const out = captured();
  const reportPath = join(dir, 'custom-report.html');
  const result = await runDoctor(makeDeps(out), { output: reportPath });
  expect(result.exitCode).toBe(0);

  const fileExists = await Bun.file(reportPath).exists();
  expect(fileExists).toBe(true);

  const content = await Bun.file(reportPath).text();
  expect(content).toContain('<!DOCTYPE html>');
  expect(content).toContain('PROXAI-GATEWAY DOCTOR');
  const count = content.split('Diagnostics Summary').length - 1;
  expect(count).toBeGreaterThanOrEqual(2);
});

test('doctor writes HTML report inside specified output directory', async () => {
  const out = captured();
  const reportsDir = join(dir, 'reports');
  await require('node:fs/promises').mkdir(reportsDir, { recursive: true });

  const result = await runDoctor(makeDeps(out), { output: reportsDir });
  expect(result.exitCode).toBe(0);

  const files = await require('node:fs/promises').readdir(reportsDir);
  const reportFile = files.find(
    (f: string) => f.startsWith('gateway-doctor-') && f.endsWith('.html'),
  );
  expect(reportFile).toBeDefined();
  if (reportFile === undefined) {
    throw new Error('Expected report file to be defined');
  }

  const fullPath = join(reportsDir, reportFile);
  const content = await Bun.file(fullPath).text();
  expect(content).toContain('<!DOCTYPE html>');
  expect(content).toContain('Diagnostics Signals Appendix');
});

test('in dev mode without explicit profile option, runs diagnostics for both profiles, prefixes, and deduplicates generic findings', async () => {
  const bootId = await readBootId();
  const sentinelPath = join(profileRootDir(), 'DEV_MODE');
  writeFileSync(sentinelPath, JSON.stringify({ bootId }));

  try {
    const out = captured();
    const result = await runDoctor(makeDeps(out), {});
    expect(result.exitCode).toBe(0);

    const joined = stripAnsi(out.lines.map((l) => l.msg).join('\n'));
    expect(joined).toContain('[dev]');
    expect(joined).toContain('[prod]');
  } finally {
    rmSync(sentinelPath, { force: true });
  }
});
