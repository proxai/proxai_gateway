#!/usr/bin/env bun
import { Command } from 'commander';

import packageJson from '../package.json' with { type: 'json' };
import { bufferDbPath, configDir, configFilePath, logDir, pausedSentinelPath } from 'core/io/fs';
import type { LogLevel } from 'core/log';
import { EXIT_CODE } from 'cli/cli.constants.ts';
import { runInstall } from 'cli/commands/install.ts';
import { runPause } from 'cli/commands/pause.ts';
import { runRedactionTest } from 'cli/commands/redaction-test.ts';
import { runResume } from 'cli/commands/resume.ts';
import { runDaemon } from 'cli/commands/run.ts';
import { runStatus } from 'cli/commands/status.ts';
import { runTail } from 'cli/commands/tail.ts';
import { runUninstall } from 'cli/commands/uninstall.ts';
import {
  defaultLaunchdPlistPath,
  defaultSystemdUnitPath,
  consoleOutput,
  inquirerPrompts,
} from 'cli/index.ts';
import { openBufferDb } from 'services/buffer';
import { loadConfigFromFile, NEST_INGEST_URL, NEST_VERIFY_KEY_URL } from 'services/config';
import type { InstallSource } from 'services/config';
import { HttpClient } from 'services/http';

const program = new Command();
program.name('proxai-gateway').description(packageJson.description).version(packageJson.version);

program
  .command('install')
  .description('Install the gateway: verify the ingestion key, write config and service unit')
  .option('--api-key <key>', 'ingestion key (skip prompt)')
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
              ingest: NEST_INGEST_URL,
              verifyKey: NEST_VERIFY_KEY_URL,
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
  .command('tail')
  .description('Show structured-log entries from the active log file')
  .option('--lines <n>', 'number of lines to show', '50')
  .option('-f, --follow', 'stream new entries until interrupted', false)
  .option('--source <name>', 'filter to one collector (claude-code | cursor | codex)')
  .option('--level <level>', 'minimum level (trace|debug|info|warn|error|fatal)')
  .option('--since <duration>', 'limit to entries after now-duration (e.g. 1h, 24h, 30m, 7d)')
  .option('--json', 'emit raw ndjson lines instead of pretty format', false)
  .option('--config <path>', 'path to config.toml')
  .action(
    async (opts: {
      lines?: string;
      follow?: boolean;
      source?: string;
      level?: string;
      since?: string;
      json?: boolean;
      config?: string;
    }) => {
      let dir = logDir();
      try {
        const config = await loadConfigFromFile(opts.config);
        dir = config.logging.logDir;
      } catch {
        // fall back to default if config missing
      }
      const ctrl = new AbortController();
      process.on('SIGINT', () => ctrl.abort());
      process.on('SIGTERM', () => ctrl.abort());
      const tailOptions: Parameters<typeof runTail>[1] = {};
      if (opts.lines !== undefined) tailOptions.lines = Number(opts.lines);
      if (opts.follow === true) tailOptions.follow = true;
      if (opts.source !== undefined) tailOptions.source = opts.source;
      if (opts.level !== undefined) tailOptions.level = opts.level as LogLevel;
      if (opts.since !== undefined) tailOptions.since = opts.since;
      if (opts.json === true) tailOptions.json = true;
      const result = await runTail(
        {
          output: consoleOutput(),
          logDir: dir,
          abortSignal: ctrl.signal,
          emit: (line) => console.log(line),
        },
        tailOptions,
      );
      process.exit(result.exitCode);
    },
  );

program
  .command('redaction-test <file>')
  .description('Run the redaction pipeline against a file and print the redacted output')
  .option('--show-rules', 'print which rules matched and how many times', false)
  .action(async (filePath: string, opts: { showRules?: boolean }) => {
    const options: Parameters<typeof runRedactionTest>[1] = { filePath };
    if (opts.showRules === true) options.showRules = true;
    const result = await runRedactionTest(
      { output: consoleOutput(), emit: (line) => console.log(line) },
      options,
    );
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
