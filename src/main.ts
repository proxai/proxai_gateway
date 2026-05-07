#!/usr/bin/env bun
import { Command } from 'commander';

import packageJson from '../package.json' with { type: 'json' };
import {
  authFailedSentinelPath,
  bufferDbPath,
  bufferFullSentinelPath,
  configDir,
  configFilePath,
  logDir,
  pausedSentinelPath,
  sessionStoppedSentinelPath,
} from 'core/io/fs';
import type { LogLevel } from 'core/log';
import { readMachineUuid } from 'core/system';
import { EXIT_CODE } from 'cli/cli.constants.ts';
import { runSetup } from 'cli/commands/setup.ts';
import type { SetupCommandDeps, SetupCommandOptions } from 'cli/commands/setup.ts';
import { runBackfill } from 'cli/commands/backfill.ts';
import { runPause } from 'cli/commands/pause.ts';
import { runRedactionList, runRedactionTest } from 'cli/commands/redaction.ts';
import { runRestart } from 'cli/commands/restart.ts';
import { runResume } from 'cli/commands/resume.ts';
import { runDaemon } from 'cli/commands/run.ts';
import { runStart } from 'cli/commands/start.ts';
import { runStatus } from 'cli/commands/status.ts';
import { runStop } from 'cli/commands/stop.ts';
import { runTail } from 'cli/commands/tail.ts';
import { runUninstall } from 'cli/commands/uninstall.ts';
import {
  defaultLaunchdPlistPath,
  defaultSystemdUnitPath,
  consoleOutput,
  inquirerPrompts,
} from 'cli/index.ts';
import { defaultScheduledTaskXmlPath } from 'cli/scheduled-task-xml.ts';
import { getServiceManager } from 'cli/service-manager.ts';
import type { CommandResult } from 'cli/cli.types.ts';
import { openBufferDb } from 'services/buffer';
import {
  loadConfigFromFile,
  NEST_INGEST_URL,
  NEST_REGISTER_HOST_ID_URL,
  NEST_VERIFY_KEY_URL,
  NEST_WATERMARKS_URL,
} from 'services/config';
import type { InstallSource } from 'services/config';
import { HttpClient } from 'services/http';

const program = new Command();
program.name('proxai-gateway').description(packageJson.description).version(packageJson.version);

function platformServiceUnitPath(platform: NodeJS.Platform): string | null {
  if (platform === 'darwin') return defaultLaunchdPlistPath();
  if (platform === 'linux') return defaultSystemdUnitPath();
  if (platform === 'win32') return defaultScheduledTaskXmlPath();
  return null;
}

function resolveWindowsUserId(): string | undefined {
  const domain = process.env['USERDOMAIN'];
  const user = process.env['USERNAME'];
  if (domain !== undefined && domain.length > 0 && user !== undefined && user.length > 0) {
    return `${domain}\\${user}`;
  }
  if (user !== undefined && user.length > 0) return user;
  return undefined;
}

function buildSetupDeps(): SetupCommandDeps {
  const platform = process.platform;
  const base: SetupCommandDeps = {
    output: consoleOutput(),
    prompts: inquirerPrompts(),
    configPath: configFilePath(),
    bufferDbPath: bufferDbPath(),
    logDir: logDir(),
    authFailedSentinelPath: authFailedSentinelPath(),
    serviceUnitPath: platformServiceUnitPath(platform),
    programPath: process.argv[1] ?? 'proxai-gateway',
    configExists: () => Bun.file(configFilePath()).exists(),
    httpClientFactory: (apiKey, hostId) =>
      new HttpClient({
        apiKey,
        hostId,
        endpoints: {
          ingest: NEST_INGEST_URL,
          verifyKey: NEST_VERIFY_KEY_URL,
          watermarks: NEST_WATERMARKS_URL,
          registerHostId: NEST_REGISTER_HOST_ID_URL,
        },
        gatewayVersion: `@proxai/gateway ${packageJson.version}`,
      }),
    readMachineUuid: () => readMachineUuid(),
    platform,
  };
  if (platform === 'win32') {
    const userId = resolveWindowsUserId();
    if (userId !== undefined) {
      base.windowsUserId = userId;
    } else {
      base.output.warn(
        'could not detect Windows user id (USERDOMAIN/USERNAME unset); using INTERACTIVE placeholder',
      );
    }
  }
  return base;
}

function invokeSetupInteractive(): Promise<CommandResult> {
  return runSetup(buildSetupDeps(), {} as SetupCommandOptions);
}

program
  .command('setup')
  .description(
    'Configure the gateway: verify the ingestion key, write config and service unit. Re-running replaces the existing key.',
  )
  .option('--api-key <key>', 'ingestion key (skip prompt)')
  .option(
    '--install-source <source>',
    'install source (bun|pnpm|yarn|npm|brew|github_release)',
    'github_release',
  )
  .action(async (opts: { apiKey?: string; installSource: string }) => {
    const result = await runSetup(buildSetupDeps(), buildSetupOptions(opts));
    process.exit(result.exitCode);
  });

program
  .command('start')
  .description('Start the proxai-gateway service (registering it on first run)')
  .action(async () => {
    const platform = process.platform;
    const unitPath = platformServiceUnitPath(platform);
    if (unitPath === null) {
      console.error(`unsupported platform for start: ${platform}`);
      process.exit(EXIT_CODE.error);
    }
    const sm = getServiceManager({
      platform,
      unitPath,
      programPath: process.argv[1] ?? 'proxai-gateway',
    });
    const result = await runStart({
      output: consoleOutput(),
      configExists: () => Bun.file(configFilePath()).exists(),
      serviceManager: sm,
      sessionStoppedSentinelPath: sessionStoppedSentinelPath(),
      invokeSetup: invokeSetupInteractive,
    });
    process.exit(result.exitCode);
  });

program
  .command('stop')
  .description('Stop the proxai-gateway service')
  .action(async () => {
    const platform = process.platform;
    const unitPath = platformServiceUnitPath(platform);
    if (unitPath === null) {
      console.error(`unsupported platform for stop: ${platform}`);
      process.exit(EXIT_CODE.error);
    }
    const sm = getServiceManager({
      platform,
      unitPath,
      programPath: process.argv[1] ?? 'proxai-gateway',
    });
    const result = await runStop({
      output: consoleOutput(),
      serviceManager: sm,
      sessionStoppedSentinelPath: sessionStoppedSentinelPath(),
    });
    process.exit(result.exitCode);
  });

program
  .command('restart')
  .description('Restart the proxai-gateway service')
  .action(async () => {
    const platform = process.platform;
    const unitPath = platformServiceUnitPath(platform);
    if (unitPath === null) {
      console.error(`unsupported platform for restart: ${platform}`);
      process.exit(EXIT_CODE.error);
    }
    const sm = getServiceManager({
      platform,
      unitPath,
      programPath: process.argv[1] ?? 'proxai-gateway',
    });
    const result = await runRestart({
      output: consoleOutput(),
      configExists: () => Bun.file(configFilePath()).exists(),
      serviceManager: sm,
      sessionStoppedSentinelPath: sessionStoppedSentinelPath(),
      invokeSetup: invokeSetupInteractive,
    });
    process.exit(result.exitCode);
  });

program
  .command('run', { hidden: true })
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
      authFailedSentinelPath: authFailedSentinelPath(),
      bufferFullSentinelPath: bufferFullSentinelPath(),
      sessionStoppedSentinelPath: sessionStoppedSentinelPath(),
      abortSignal: ctrl.signal,
      gatewayVersion: `@proxai/gateway ${packageJson.version}`,
    });
    process.exit(result.exitCode);
  });

program
  .command('backfill')
  .description('Run a single capture cycle ingesting history older than the default 30-day window')
  .requiredOption('--since <duration>', 'lookback window: Nd (days), Nmo (months), or Ny (years)')
  .option('--config <path>', 'path to config.toml')
  .action(async (opts: { since: string; config?: string }) => {
    const config = await loadConfigFromFile(opts.config);
    const platform = process.platform;
    const unitPath = platformServiceUnitPath(platform);
    const sm =
      unitPath !== null
        ? getServiceManager({
            platform,
            unitPath,
            programPath: process.argv[1] ?? 'proxai-gateway',
          })
        : null;
    const result = await runBackfill(
      {
        output: consoleOutput(),
        config,
        pauseSentinelPath: pausedSentinelPath(),
        authFailedSentinelPath: authFailedSentinelPath(),
        bufferFullSentinelPath: bufferFullSentinelPath(),
        gatewayVersion: `@proxai/gateway ${packageJson.version}`,
        ...(sm !== null ? { isDaemonRunning: () => sm.isRunning() } : {}),
      },
      { since: opts.since },
    );
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
    } catch {}
    const buffer = openBufferDb(bufferPath);
    try {
      const result = await runStatus({
        output: consoleOutput(),
        buffer,
        sentinelPath: pausedSentinelPath(),
        bufferFullSentinelPath: bufferFullSentinelPath(),
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
  .description('Stop and unregister the gateway service. Use --reset to wipe local data too.')
  .option('--reset', 'also wipe ~/.proxai/, logs, and service unit file', false)
  .option('-y, --yes', 'skip confirmation prompt for --reset', false)
  .action(async (opts: { reset?: boolean; yes?: boolean }) => {
    const platform = process.platform;
    const unitPath = platformServiceUnitPath(platform);
    if (unitPath === null) {
      console.error(`unsupported platform for uninstall: ${platform}`);
      process.exit(EXIT_CODE.error);
    }
    const sm = getServiceManager({
      platform,
      unitPath,
      programPath: process.argv[1] ?? 'proxai-gateway',
    });
    const uninstallOptions: { reset?: boolean; yes?: boolean } = {};
    if (opts.reset === true) uninstallOptions.reset = true;
    if (opts.yes === true) uninstallOptions.yes = true;
    const result = await runUninstall(
      {
        output: consoleOutput(),
        prompts: inquirerPrompts(),
        configPath: configFilePath(),
        configDir: configDir(),
        logDir: logDir(),
        serviceUnitPath: unitPath,
        serviceManager: sm,
        configExists: () => Bun.file(configFilePath()).exists(),
      },
      uninstallOptions,
    );
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
      } catch {}
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

const redaction = program
  .command('redaction')
  .description('Inspect and test the redaction pipeline');

redaction
  .command('test <file>')
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

redaction
  .command('list')
  .description('List all redaction rules grouped by category')
  .option('--categories', 'list only category names with rule counts', false)
  .option('--category <name>', 'filter to one category (full detail)')
  .option('--json', 'emit raw JSON output instead of pretty format', false)
  .action((opts: { categories?: boolean; category?: string; json?: boolean }) => {
    const options: Parameters<typeof runRedactionList>[1] = {};
    if (opts.categories === true) options.categories = true;
    if (opts.category !== undefined) options.category = opts.category;
    if (opts.json === true) options.json = true;
    const result = runRedactionList(
      { output: consoleOutput(), emit: (line) => console.log(line) },
      options,
    );
    process.exit(result.exitCode);
  });

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(EXIT_CODE.error);
});

function buildSetupOptions(opts: { apiKey?: string; installSource: string }): {
  apiKey?: string;
  installSource?: InstallSource;
} {
  const VALID = ['bun', 'pnpm', 'yarn', 'npm', 'brew', 'github_release'] as const;
  type Source = (typeof VALID)[number];
  const installSource = (VALID as readonly string[]).includes(opts.installSource)
    ? (opts.installSource as Source)
    : ('github_release' as Source);
  const out: { apiKey?: string; installSource?: InstallSource } = {
    installSource,
  };
  if (opts.apiKey !== undefined) out.apiKey = opts.apiKey;
  return out;
}
