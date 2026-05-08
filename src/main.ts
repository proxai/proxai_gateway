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
  updateAvailableSentinelPath,
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
import { runUpgrade } from 'cli/commands/upgrade.ts';
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
  const unitPath = platformServiceUnitPath(platform);
  const base: SetupCommandDeps = {
    output: consoleOutput(),
    prompts: inquirerPrompts(),
    configPath: configFilePath(),
    bufferDbPath: bufferDbPath(),
    logDir: logDir(),
    authFailedSentinelPath: authFailedSentinelPath(),
    sessionStoppedSentinelPath: sessionStoppedSentinelPath(),
    serviceUnitPath: unitPath,
    programPath: process.execPath,
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
  if (unitPath !== null) {
    base.serviceManager = getServiceManager({
      platform,
      unitPath,
      programPath: process.execPath,
    });
  }
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
    'Configure the gateway with your ingestion key. Verifies the key, writes ~/.proxai/proxai-gateway/config.toml, installs the platform service unit, and starts the daemon.',
  )
  .option(
    '--api-key <key>',
    'ingestion key to verify and store; skips the interactive prompt. Get one at https://proxai.co.',
  )
  .option(
    '--install-source <source>',
    'how this binary was installed; reported to the backend for diagnostics. One of: bun, pnpm, yarn, npm, brew, github_release.',
    'github_release',
  )
  .option(
    '--no-start',
    'finish setup without registering or starting the platform service. Run `proxai-gateway start` manually when ready.',
    false,
  )
  .action(async (opts: { apiKey?: string; installSource: string; start?: boolean }) => {
    const result = await runSetup(buildSetupDeps(), buildSetupOptions(opts));
    process.exit(result.exitCode);
  });

program
  .command('start')
  .description(
    'Register the gateway as a managed service (launchd / systemd / Scheduled Task) and start the daemon. Auto-restarts on reboot. Requires a prior `setup`.',
  )
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
      programPath: process.execPath,
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
  .description(
    'Halt the running gateway daemon for this session. The service remains registered and will start again automatically on next reboot. Use `uninstall` to fully decommission.',
  )
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
      programPath: process.execPath,
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
  .description('Stop and start the gateway daemon. Equivalent to `stop` followed by `start`.')
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
      programPath: process.execPath,
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
  .description(
    'Run the gateway daemon in the foreground (used by the service unit; not for direct invocation).',
  )
  .option('--config <path>', 'override the default ~/.proxai/proxai-gateway/config.toml path')
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
      updateAvailableSentinelPath: updateAvailableSentinelPath(),
      abortSignal: ctrl.signal,
      gatewayVersion: `@proxai/gateway ${packageJson.version}`,
    });
    process.exit(result.exitCode);
  });

program
  .command('backfill')
  .description(
    'Capture extended history beyond the default 30-day window. Runs a one-shot capture cycle and exits; the daemon must be stopped while this runs.',
  )
  .requiredOption(
    '--since <duration>',
    'lookback window. Format: Nd (days), Nmo (months), or Ny (years). Examples: 90d, 6mo, 1y.',
  )
  .option('--config <path>', 'override the default ~/.proxai/proxai-gateway/config.toml path')
  .action(async (opts: { since: string; config?: string }) => {
    const config = await loadConfigFromFile(opts.config);
    const platform = process.platform;
    const unitPath = platformServiceUnitPath(platform);
    const sm =
      unitPath !== null
        ? getServiceManager({
            platform,
            unitPath,
            programPath: process.execPath,
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
  .description(
    'Print gateway state: health dot, per-source captures, buffer occupancy, last-cycle drain results, sentinel flags.',
  )
  .option('--config <path>', 'override the default ~/.proxai/proxai-gateway/config.toml path')
  .option('--json', 'emit machine-readable JSON instead of the human-readable layout', false)
  .action(async (opts: { config?: string; json?: boolean }) => {
    const configPath = configFilePath();
    const exists = await Bun.file(configPath).exists();
    if (!exists) {
      const result = await runStatus(
        {
          output: consoleOutput(),
          configPath,
          configExists: () => Promise.resolve(false),
          pauseSentinelPath: pausedSentinelPath(),
          bufferFullSentinelPath: bufferFullSentinelPath(),
          authFailedSentinelPath: authFailedSentinelPath(),
          sessionStoppedSentinelPath: sessionStoppedSentinelPath(),
          updateAvailableSentinelPath: updateAvailableSentinelPath(),
        },
        opts.json === true ? { json: true } : {},
      );
      process.exit(result.exitCode);
    }
    let bufferPath = bufferDbPath();
    try {
      const config = await loadConfigFromFile(opts.config);
      bufferPath = config.capture.bufferPath;
    } catch {}
    const buffer = openBufferDb(bufferPath);
    try {
      const result = await runStatus(
        {
          output: consoleOutput(),
          buffer,
          configPath,
          configExists: () => Promise.resolve(true),
          pauseSentinelPath: pausedSentinelPath(),
          bufferFullSentinelPath: bufferFullSentinelPath(),
          authFailedSentinelPath: authFailedSentinelPath(),
          sessionStoppedSentinelPath: sessionStoppedSentinelPath(),
          updateAvailableSentinelPath: updateAvailableSentinelPath(),
        },
        opts.json === true ? { json: true } : {},
      );
      process.exit(result.exitCode);
    } finally {
      buffer.close();
    }
  });

program
  .command('pause')
  .description(
    'Pause polling indefinitely by writing a PAUSED sentinel. The daemon keeps running but skips capture cycles. Persists across reboots until cleared with `resume`.',
  )
  .option('--reason <reason>', 'free-form reason recorded in the sentinel file (shown by `status`)')
  .action(async (opts: { reason?: string }) => {
    const result = await runPause(
      { output: consoleOutput(), sentinelPath: pausedSentinelPath() },
      opts.reason !== undefined ? { reason: opts.reason } : {},
    );
    process.exit(result.exitCode);
  });

program
  .command('resume')
  .description('Clear the PAUSED sentinel and resume capture cycles on the next polling tick.')
  .action(async () => {
    const result = await runResume({
      output: consoleOutput(),
      sentinelPath: pausedSentinelPath(),
    });
    process.exit(result.exitCode);
  });

program
  .command('uninstall')
  .description(
    'Stop the daemon and unregister the platform service unit. Local config and logs are preserved unless `--reset` is passed.',
  )
  .option(
    '--reset',
    'also delete ~/.proxai/proxai-gateway/ (config + buffer + sentinels), the gateway log directory, and the service unit file. Destructive: requires confirmation unless --yes is given.',
    false,
  )
  .option('-y, --yes', 'skip the interactive confirmation prompt for `--reset`', false)
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
      programPath: process.execPath,
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
  .command('upgrade')
  .description(
    'Manually fetch the latest gateway release from GitHub and replace the running binary. On Windows, writes the new binary alongside the existing one (restart required to apply).',
  )
  .option('-y, --yes', 'skip the interactive confirmation prompt', false)
  .option('--force', 'redownload and reinstall even if already on the latest version', false)
  .action(async (opts: { yes?: boolean; force?: boolean }) => {
    const upgradeOptions: { yes?: boolean; force?: boolean } = {};
    if (opts.yes === true) upgradeOptions.yes = true;
    if (opts.force === true) upgradeOptions.force = true;
    const result = await runUpgrade(
      {
        output: consoleOutput(),
        prompts: inquirerPrompts(),
        currentVersion: packageJson.version,
        binaryPath: process.execPath,
      },
      upgradeOptions,
    );
    process.exit(result.exitCode);
  });

program
  .command('tail')
  .description(
    'Stream structured (ndjson) log entries from the active gateway log file. Pretty-prints by default; combine filters as needed.',
  )
  .option('--lines <n>', 'number of trailing entries to print before applying filters', '50')
  .option(
    '-f, --follow',
    'keep the stream open and print new entries as they are written; exit with Ctrl-C',
    false,
  )
  .option(
    '--source <name>',
    'show only entries from one collector. One of: claude-code, cursor, codex.',
  )
  .option(
    '--level <level>',
    'minimum log level to include (everything at or above this level passes). One of: trace, debug, info, warn, error, fatal.',
  )
  .option(
    '--since <duration>',
    'limit to entries newer than now minus this duration. Format: Nm (minutes), Nh (hours), Nd (days). Examples: 30m, 2h, 7d.',
  )
  .option(
    '--raw',
    'emit raw ndjson lines as written on disk, bypassing pretty formatting (useful for piping to jq)',
    false,
  )
  .option('--config <path>', 'override the default ~/.proxai/proxai-gateway/config.toml path')
  .action(
    async (opts: {
      lines?: string;
      follow?: boolean;
      source?: string;
      level?: string;
      since?: string;
      raw?: boolean;
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
      if (opts.raw === true) tailOptions.raw = true;
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
  .description('Inspect the on-device secret-redaction rules and try them against a sample file.');

redaction
  .command('test <file>')
  .description(
    'Run the full redaction pipeline against a local file and print what would be uploaded. The file is never sent anywhere; this is a local-only dry run.',
  )
  .option(
    '--show-rules',
    'after the redacted output, print a summary of which rules matched and how many times',
    false,
  )
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
  .description(
    'List the active redaction rules grouped by category (e.g. llm-providers, cloud-providers, communication).',
  )
  .option('--categories', 'show only the category names and a rule count per category', false)
  .option('--category <name>', 'restrict the listing to one category (full per-rule detail)')
  .option(
    '--json',
    'emit raw JSON instead of the pretty table format (useful for piping to jq)',
    false,
  )
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

function buildSetupOptions(opts: { apiKey?: string; installSource: string; start?: boolean }): {
  apiKey?: string;
  installSource?: InstallSource;
  noStart?: boolean;
} {
  const VALID = ['bun', 'pnpm', 'yarn', 'npm', 'brew', 'github_release'] as const;
  type Source = (typeof VALID)[number];
  const installSource = (VALID as readonly string[]).includes(opts.installSource)
    ? (opts.installSource as Source)
    : ('github_release' as Source);
  const out: { apiKey?: string; installSource?: InstallSource; noStart?: boolean } = {
    installSource,
  };
  if (opts.apiKey !== undefined) out.apiKey = opts.apiKey;
  if (opts.start === false) out.noStart = true;
  return out;
}
