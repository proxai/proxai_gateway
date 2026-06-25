import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { rmRecursive } from 'core/io/fs';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const ENTRY = join(REPO_ROOT, 'src', 'main.ts');
const TEST_BOOT_ID = 'profile-opt-test-boot';

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'proxai-profile-opt-'));
});

afterEach(async () => {
  await rmRecursive(workdir);
});

interface RunResult {
  output: string;
  exitCode: number;
}

async function runCli(args: string[], profileRoot: string): Promise<RunResult> {
  const proc = Bun.spawn(['bun', ENTRY, ...args], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    env: {
      ...process.env,
      PROXAI_TEST_PROFILE_ROOT: profileRoot,
      PROXAI_TEST_BOOT_ID: TEST_BOOT_ID,
    },
  });
  const killer = setTimeout(() => proc.kill(), 12_000);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(killer);
  return { output: `${stdout}\n${stderr}`, exitCode };
}

async function enableDevMode(profileRoot: string): Promise<void> {
  writeFileSync(join(profileRoot, 'DEV_MODE'), JSON.stringify({ bootId: TEST_BOOT_ID }));
}

function seedConfig(profileRoot: string, profile: 'prod' | 'dev'): string {
  const dir = join(profileRoot, profile);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'config.toml');
  writeFileSync(path, 'seed');
  return path;
}

test('prod mode rejects --profile dev on a user command as an unknown option', async () => {
  const result = await runCli(['status', '--json', '--profile', 'dev'], workdir);
  expect(result.output).toContain("unknown option '--profile'");
  expect(result.exitCode).not.toBe(0);
}, 30_000);

test('prod mode rejects --profile prod on a user command as an unknown option', async () => {
  const result = await runCli(['status', '--json', '--profile', 'prod'], workdir);
  expect(result.output).toContain("unknown option '--profile'");
  expect(result.exitCode).not.toBe(0);
}, 30_000);

test('prod mode rejects --profile on uninstall as an unknown option', async () => {
  const result = await runCli(['uninstall', '--profile', 'prod'], workdir);
  expect(result.output).toContain("unknown option '--profile'");
  expect(result.exitCode).not.toBe(0);
}, 30_000);

test('dev mode accepts --profile dev on a user command and targets the dev profile', async () => {
  await enableDevMode(workdir);
  const result = await runCli(['status', '--json', '--profile', 'dev'], workdir);
  expect(result.output).not.toContain('unknown option');
  expect(result.output).toContain('"isDevMode":true');
}, 30_000);

test('dev mode accepts --profile prod on a user command', async () => {
  await enableDevMode(workdir);
  const result = await runCli(['status', '--json', '--profile', 'prod'], workdir);
  expect(result.output).not.toContain('unknown option');
  expect(result.output).toContain('"isDevMode":true');
}, 30_000);

test('run keeps --profile prod regardless of dev mode (prod mode)', async () => {
  const result = await runCli(
    ['run', '--profile', 'prod', '--config', join(workdir, 'missing.toml')],
    workdir,
  );
  expect(result.output).not.toContain('unknown option');
  expect(result.output).toContain('config file not found');
}, 30_000);

test('run keeps --profile dev regardless of dev mode (prod mode)', async () => {
  const result = await runCli(
    ['run', '--profile', 'dev', '--config', join(workdir, 'missing.toml')],
    workdir,
  );
  expect(result.output).not.toContain('unknown option');
  expect(result.output).toContain('config file not found');
}, 30_000);

test('setup reset --profile dev removes only the dev config, never the prod config', async () => {
  await enableDevMode(workdir);
  const devConfig = seedConfig(workdir, 'dev');
  const prodConfig = seedConfig(workdir, 'prod');
  const result = await runCli(['setup', 'reset', '--profile', 'dev', '-y'], workdir);
  expect(result.output).not.toContain('unknown option');
  expect(existsSync(devConfig)).toBe(false);
  expect(existsSync(prodConfig)).toBe(true);
}, 30_000);

test('setup reset --profile prod removes only the prod config, never the dev config', async () => {
  await enableDevMode(workdir);
  const devConfig = seedConfig(workdir, 'dev');
  const prodConfig = seedConfig(workdir, 'prod');
  const result = await runCli(['setup', 'reset', '--profile', 'prod', '-y'], workdir);
  expect(result.output).not.toContain('unknown option');
  expect(existsSync(prodConfig)).toBe(false);
  expect(existsSync(devConfig)).toBe(true);
}, 30_000);

test('redaction list is executable in prod mode', async () => {
  const result = await runCli(['redaction', 'list', '--categories'], workdir);
  expect(result.output).not.toContain('unknown option');
  expect(result.exitCode).toBe(0);
}, 30_000);

test('redaction list is executable in dev mode', async () => {
  await enableDevMode(workdir);
  const result = await runCli(['redaction', 'list', '--categories'], workdir);
  expect(result.output).not.toContain('unknown option');
  expect(result.exitCode).toBe(0);
}, 30_000);

test('redaction list rejects --profile option in both modes', async () => {
  const resultProd = await runCli(['redaction', 'list', '--profile', 'dev'], workdir);
  expect(resultProd.output).toContain("unknown option '--profile'");
  expect(resultProd.exitCode).not.toBe(0);

  await enableDevMode(workdir);
  const resultDev = await runCli(['redaction', 'list', '--profile', 'dev'], workdir);
  expect(resultDev.output).toContain("unknown option '--profile'");
  expect(resultDev.exitCode).not.toBe(0);
}, 30_000);
