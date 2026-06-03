import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test';

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

let interceptHtmlWrite = false;
let capturedWritePath: string | null = null;

mock.module('node:fs/promises', () => {
  const actual: typeof import('node:fs/promises') = import.meta.require('node:fs/promises');
  return {
    ...actual,
    writeFile: (path: string, data: string, encoding: 'utf-8'): Promise<void> => {
      if (interceptHtmlWrite && typeof path === 'string' && path.endsWith('.html')) {
        capturedWritePath = path;
        return Promise.resolve();
      }
      return actual.writeFile(path, data, encoding);
    },
  };
});

import { requireDefined } from 'core/utils';
import { rmRecursive } from 'core/io/fs';
import { openBufferDb } from 'services/buffer';
import { runDoctor } from 'cli/commands/doctor/index.ts';
import { captureOutput } from 'cli/output.ts';
import type { OutputSink } from 'cli/cli.types.ts';
import type { DoctorCommandDeps } from 'cli/commands/doctor/doctor.types.ts';
import type { ServiceManager } from 'cli/service-manager';
import { profileRootDir } from 'core/io/fs/profile.ts';
import { homedir } from 'node:os';
import { writeFileSync, rmSync, mkdirSync } from 'node:fs';

// Injected as deps.readBootId so DEV_MODE detection is deterministic — the real
// readBootId throws on CI Linux (empty /proc boot_id) and is slow on Windows.
const DOCTOR_BOOT_ID = 'test-boot-id-doctor';

let dir: string;
let bufferDbPath: string;

const origHome = process.env.HOME;
const origProfileRoot = process.env['PROXAI_TEST_PROFILE_ROOT'];
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
    readBootId: () => Promise.resolve(DOCTOR_BOOT_ID),
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
  process.env.HOME = dir;
  process.env['PROXAI_TEST_PROFILE_ROOT'] = dir;
  mkdirSync(profileRootDir(), { recursive: true });
  bufferDbPath = join(dir, 'buffer.db');
  const db = openBufferDb(bufferDbPath);
  db.close();
  globalThis.fetch = (() =>
    Promise.resolve(new Response('ok', { status: 200 }))) as unknown as typeof globalThis.fetch;
  (Bun as unknown as { which: typeof Bun.which }).which = (() => null) as typeof Bun.which;
});

afterEach(async () => {
  process.env.HOME = origHome;
  if (origProfileRoot === undefined) {
    delete process.env['PROXAI_TEST_PROFILE_ROOT'];
  } else {
    process.env['PROXAI_TEST_PROFILE_ROOT'] = origProfileRoot;
  }
  globalThis.fetch = origFetch;
  (Bun as unknown as { which: typeof Bun.which }).which = origWhich;
  interceptHtmlWrite = false;
  capturedWritePath = null;
  await rmRecursive(dir);
});

afterAll(async () => {
  const fsPromisesReal = await import('node:fs/promises');
  mock.module('node:fs/promises', () => fsPromisesReal);
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
  expect(content).toContain('<div class="wordmark">ProxAI</div>');
  expect(content).not.toContain('cdn.tailwindcss.com');
  expect(content).not.toContain('Antigravity');
  const count = content.split('Diagnostics Summary').length - 1;
  expect(count).toBe(1);
});

test('doctor with bare --output flag targets the home Desktop directory', async () => {
  interceptHtmlWrite = true;
  const out = captured();
  const result = await runDoctor(makeDeps(out), { output: true });
  expect(result.exitCode).toBe(0);

  const path = requireDefined(capturedWritePath);
  const segments = path.split(sep);
  const filename = requireDefined(segments[segments.length - 1]);
  const parentSegment = requireDefined(segments[segments.length - 2]);
  expect(parentSegment).toBe('Desktop');
  expect(filename.startsWith('gateway-doctor-')).toBe(true);
  expect(filename.endsWith('.html')).toBe(true);
  expect(path).toBe(join(homedir(), 'Desktop', filename));
});

test('doctor with empty-string --output flag also targets the home Desktop directory', async () => {
  interceptHtmlWrite = true;
  const out = captured();
  const result = await runDoctor(makeDeps(out), { output: '' });
  expect(result.exitCode).toBe(0);

  const path = requireDefined(capturedWritePath);
  expect(path.startsWith(join(homedir(), 'Desktop') + sep)).toBe(true);
  expect(path.endsWith('.html')).toBe(true);
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
  expect(content).toContain('Signals Appendix');
});

test('in dev mode without explicit profile option, runs diagnostics for both profiles, prefixes, and deduplicates generic findings', async () => {
  const bootId = DOCTOR_BOOT_ID;
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

test('in dev mode with explicit profile, applies profile-specific prefix only to non-generic findings', async () => {
  const bootId = DOCTOR_BOOT_ID;
  const sentinelPath = join(profileRootDir(), 'DEV_MODE');
  writeFileSync(sentinelPath, JSON.stringify({ bootId }));

  try {
    globalThis.fetch = (() =>
      Promise.reject(new Error('unreachable'))) as unknown as typeof globalThis.fetch;

    const out = captured();
    const result = await runDoctor(
      makeDeps(out, { serviceManager: serviceManager(false, false) }),
      { profile: 'dev' },
    );
    expect(result.exitCode).toBe(0);

    const joined = stripAnsi(out.lines.map((l) => l.msg).join('\n'));
    expect(joined).toContain('[dev] The gateway is not configured');
    expect(joined).toContain('The Nest API endpoint is unreachable');
    expect(joined).not.toContain('[dev] The Nest API endpoint is unreachable');
  } finally {
    rmSync(sentinelPath, { force: true });
  }
});

test('in dev mode without explicit profile option, deduplicates generic findings appearing in both profiles', async () => {
  const bootId = DOCTOR_BOOT_ID;
  const sentinelPath = join(profileRootDir(), 'DEV_MODE');
  writeFileSync(sentinelPath, JSON.stringify({ bootId }));

  const origSpawn = Bun.spawn;
  try {
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = ((args: string[], options?: object) => {
      if (args.includes('df')) {
        return {
          stdout:
            new Response(
              'Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/sda1 1000 990 10 99% /',
            ).body ?? new ReadableStream(),
          exited: Promise.resolve(0),
        };
      }
      return origSpawn(args, options);
    }) as unknown as typeof Bun.spawn;

    const out = captured();
    const result = await runDoctor(makeDeps(out), {});
    expect(result.exitCode).toBe(0);

    const joined = stripAnsi(out.lines.map((l) => l.msg).join('\n'));
    expect(joined).toContain('F2');
  } finally {
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = origSpawn;
    rmSync(sentinelPath, { force: true });
  }
});

test('in dev mode without explicit profile option, handles generic findings appearing only in prod profile', async () => {
  const bootId = DOCTOR_BOOT_ID;
  const sentinelPath = join(profileRootDir(), 'DEV_MODE');
  writeFileSync(sentinelPath, JSON.stringify({ bootId }));

  const origSpawn = Bun.spawn;
  try {
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = ((args: string[], options?: object) => {
      if (args.includes('df')) {
        const path = args[args.length - 1];
        if (path && path.includes('prod')) {
          return {
            stdout:
              new Response(
                'Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/sda1 1000 990 10 99% /',
              ).body ?? new ReadableStream(),
            exited: Promise.resolve(0),
          };
        }
        return {
          stdout:
            new Response(
              'Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/sda1 10000000 500 9000000 5% /',
            ).body ?? new ReadableStream(),
          exited: Promise.resolve(0),
        };
      }
      return origSpawn(args, options);
    }) as unknown as typeof Bun.spawn;

    const out = captured();
    const result = await runDoctor(makeDeps(out), {});
    expect(result.exitCode).toBe(0);

    const joined = stripAnsi(out.lines.map((l) => l.msg).join('\n'));
    expect(joined).toContain('F2');
  } finally {
    (Bun as unknown as { spawn: typeof Bun.spawn }).spawn = origSpawn;
    rmSync(sentinelPath, { force: true });
  }
});

test('dynamic path replacement of legacy ~/.proxai with space quotes path', async () => {
  await writeFile(join(dir, 'config.toml'), 'api_key = "secret"\n');
  const badDir = join(dir, 'unwritable path');
  const out = captured();
  const result = await runDoctor(
    makeDeps(out, {
      configDirPath: badDir,
      configFilePath: join(dir, 'config.toml'),
    }),
    {},
  );
  expect(result.exitCode).toBe(0);
  const joined = stripAnsi(out.lines.map((l) => l.msg).join('\n'));
  expect(joined).toContain('F1');
  expect(joined).not.toContain('~/.proxai');
  expect(joined).toContain("unwritable path'");
});
