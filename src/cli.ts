#!/usr/bin/env bun
import { Command } from 'commander';

import packageJson from '../package.json' with { type: 'json' };
import { bufferDbPath, configDir, configFilePath, logDir, pausedSentinelPath } from 'core/io/fs';
import { EXIT_CODE } from 'cli/cli.constants.ts';
import { runInstall } from 'cli/command-install.ts';
import { runPause } from 'cli/command-pause.ts';
import { runResume } from 'cli/command-resume.ts';
import { runDaemon } from 'cli/command-run.ts';
import { runStatus } from 'cli/command-status.ts';
import { runUninstall } from 'cli/command-uninstall.ts';
import {
  defaultLaunchdPlistPath,
  defaultSystemdUnitPath,
  consoleOutput,
  inquirerPrompts,
} from 'cli/index.ts';
import { openBufferDb } from 'services/buffer';
import { loadConfigFromFile } from 'services/config';
import type { InstallSource } from 'services/config';
import { HttpClient } from 'services/http';

const program = new Command();
program.name('proxai-gateway').description(packageJson.description).version(packageJson.version);

program
  .command('install')
  .description('Install the gateway: validate API key, pin host, write config and service unit')
  .option('--api-key <key>', 'API key (skip prompt)')
  .option('-y, --yes', 'overwrite an existing install without confirming')
  .option(
    '--install-source <source>',
    'install source (bun|pnpm|yarn|npm|brew|github_release)',
    'github_release',
  )
  .action(async (opts: { apiKey?: string; yes?: boolean; installSource: string }) => {
    const platform = process.platform;
    const serviceUnitPath =
      platform === 'darwin'
        ? defaultLaunchdPlistPath()
        : platform === 'linux'
          ? defaultSystemdUnitPath()
          : null;
    const result = await runInstall(
      {
        output: consoleOutput(),
        prompts: inquirerPrompts(),
        configPath: configFilePath(),
        bufferDbPath: bufferDbPath(),
        logDir: logDir(),
        serviceUnitPath,
        programPath: process.argv[1] ?? 'proxai-gateway',
        configExists: () => Bun.file(configFilePath()).exists(),
        httpClientFactory: (apiKey, hostId) =>
          new HttpClient({
            apiKey,
            hostId,
            endpoints: {
              ingest: 'https://nest.proxai.co/v1/raw_records',
              authValidate: 'https://nest.proxai.co/v1/auth/validate',
              health: 'https://nest.proxai.co/v1/health',
              latestVersion: 'https://nest.proxai.co/v1/gateway/latest_version',
              allowedHosts: 'https://nest.proxai.co/v1/api-keys',
            },
            gatewayVersion: `@proxai/gateway ${packageJson.version}`,
          }),
        platform,
      },
      buildInstallOptions(opts),
    );
    process.exit(result.exitCode);
  });

program
  .command('run')
  .description('Run the gateway daemon (poll + ship loop)')
  .option('--config <path>', 'path to config.toml')
  .action(async (opts: { config?: string }) => {
    const config = await loadConfigFromFile(opts.config);
    const ctrl = new AbortController();
    process.on('SIGINT', () => ctrl.abort());
    process.on('SIGTERM', () => ctrl.abort());
    const result = await runDaemon({
      output: consoleOutput(),
      config,
      pauseSentinelPath: pausedSentinelPath(),
      abortSignal: ctrl.signal,
      gatewayVersion: `@proxai/gateway ${packageJson.version}`,
    });
    process.exit(result.exitCode);
  });

program
  .command('status')
  .description('Show buffer status')
  .option('--config <path>', 'path to config.toml')
  .action(async (opts: { config?: string }) => {
    let bufferPath = bufferDbPath();
    try {
      const config = await loadConfigFromFile(opts.config);
      bufferPath = config.capture.bufferPath;
    } catch {
      // Fall back to default path if config missing.
    }
    const buffer = openBufferDb(bufferPath);
    try {
      const result = await runStatus({
        output: consoleOutput(),
        buffer,
        sentinelPath: pausedSentinelPath(),
      });
      process.exit(result.exitCode);
    } finally {
      buffer.close();
    }
  });

program
  .command('pause')
  .description('Pause polling')
  .option('--reason <reason>', 'reason for pause')
  .action(async (opts: { reason?: string }) => {
    const result = await runPause(
      { output: consoleOutput(), sentinelPath: pausedSentinelPath() },
      opts.reason !== undefined ? { reason: opts.reason } : {},
    );
    process.exit(result.exitCode);
  });

program
  .command('resume')
  .description('Resume polling')
  .action(async () => {
    const result = await runResume({
      output: consoleOutput(),
      sentinelPath: pausedSentinelPath(),
    });
    process.exit(result.exitCode);
  });

program
  .command('uninstall')
  .description('Remove all gateway state')
  .option('-y, --yes', 'skip confirm prompt')
  .action(async (opts: { yes?: boolean }) => {
    const platform = process.platform;
    const serviceUnitPath =
      platform === 'darwin'
        ? defaultLaunchdPlistPath()
        : platform === 'linux'
          ? defaultSystemdUnitPath()
          : null;
    const result = await runUninstall(
      {
        output: consoleOutput(),
        prompts: inquirerPrompts(),
        configDir: configDir(),
        serviceUnitPath,
        configExists: () => Bun.file(configFilePath()).exists(),
      },
      opts.yes === true ? { yes: true } : {},
    );
    process.exit(result.exitCode);
  });

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(EXIT_CODE.error);
});

function buildInstallOptions(opts: { apiKey?: string; yes?: boolean; installSource: string }): {
  apiKey?: string;
  yes?: boolean;
  installSource?: InstallSource;
} {
  const VALID = ['bun', 'pnpm', 'yarn', 'npm', 'brew', 'github_release'] as const;
  type Source = (typeof VALID)[number];
  const installSource = (VALID as readonly string[]).includes(opts.installSource)
    ? (opts.installSource as Source)
    : ('github_release' as Source);
  const out: { apiKey?: string; yes?: boolean; installSource?: InstallSource } = {
    installSource,
  };
  if (opts.apiKey !== undefined) out.apiKey = opts.apiKey;
  if (opts.yes !== undefined) out.yes = opts.yes;
  return out;
}
