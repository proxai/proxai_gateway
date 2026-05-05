import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runUninstall } from 'cli/command-uninstall.ts';
import { captureOutput } from 'cli/output.ts';
import { scriptedPrompts } from 'cli/prompts.ts';

let dir: string;
let configDir: string;
let configPath: string;
let serviceUnitPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-cli-uninstall-'));
  configDir = join(dir, 'cfg');
  configPath = join(configDir, 'config.toml');
  serviceUnitPath = join(dir, 'unit.plist');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function seedInstall(): Promise<void> {
  await writeFile(configPath, 'placeholder', { flag: 'w' }).catch(async () => {
    await Bun.write(configPath, 'placeholder');
  });
  await Bun.write(serviceUnitPath, 'unit content');
}

test('reports not installed when no config file present', async () => {
  const out = captureOutput();
  const result = await runUninstall({
    output: out,
    prompts: scriptedPrompts({}),
    configDir,
    serviceUnitPath,
    configExists: () => Bun.file(configPath).exists(),
  });
  expect(result.exitCode).toBe(4);
  expect(out.lines.some((l) => l.msg.includes('nothing to uninstall'))).toBe(true);
});

test('aborts when prompt declines', async () => {
  await seedInstall();
  const out = captureOutput();
  const result = await runUninstall({
    output: out,
    prompts: scriptedPrompts({ uninstall: false }),
    configDir,
    serviceUnitPath,
    configExists: () => Bun.file(configPath).exists(),
  });
  expect(result.exitCode).toBe(0);
  expect(out.lines.some((l) => l.msg.includes('uninstall aborted'))).toBe(true);
  expect(await Bun.file(configPath).exists()).toBe(true);
});

test('removes configDir and service unit on confirm', async () => {
  await seedInstall();
  const out = captureOutput();
  const result = await runUninstall({
    output: out,
    prompts: scriptedPrompts({ uninstall: true }),
    configDir,
    serviceUnitPath,
    configExists: () => Bun.file(configPath).exists(),
  });
  expect(result.exitCode).toBe(0);
  expect(await Bun.file(configPath).exists()).toBe(false);
  expect(await Bun.file(serviceUnitPath).exists()).toBe(false);
});

test('skips prompt with --yes flag', async () => {
  await seedInstall();
  const out = captureOutput();
  const result = await runUninstall(
    {
      output: out,
      prompts: scriptedPrompts({}),
      configDir,
      serviceUnitPath,
      configExists: () => Bun.file(configPath).exists(),
    },
    { yes: true },
  );
  expect(result.exitCode).toBe(0);
  expect(await Bun.file(configPath).exists()).toBe(false);
});

test('handles null serviceUnitPath gracefully', async () => {
  await Bun.write(configPath, 'placeholder');
  const out = captureOutput();
  const result = await runUninstall(
    {
      output: out,
      prompts: scriptedPrompts({}),
      configDir,
      serviceUnitPath: null,
      configExists: () => Bun.file(configPath).exists(),
    },
    { yes: true },
  );
  expect(result.exitCode).toBe(0);
  expect(await Bun.file(configPath).exists()).toBe(false);
});
