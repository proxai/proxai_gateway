#!/usr/bin/env bun
import chalk from 'chalk';
import { Command } from 'commander';

import { EXIT_CODE } from 'cli/cli.constants.ts';

import { runDev } from 'cli/commands/dev.ts';
import { runPause } from 'cli/commands/pause.ts';
import { runRedactionList, runRedactionTest } from 'cli/commands/redaction.ts';
import { runRestart } from 'cli/commands/restart.ts';
import { runResume } from 'cli/commands/resume.ts';
import { runDaemon } from 'cli/commands/run';
import { runSetup } from 'cli/commands/setup';
import { runStart } from 'cli/commands/start.ts';
import { runStatus } from 'cli/commands/status';
import { runStop } from 'cli/commands/stop.ts';
import { runTail } from 'cli/commands/tail';
import { runUninstall } from 'cli/commands/uninstall';
import { runUpgrade } from 'cli/commands/upgrade.ts';
import { runInspect } from 'cli/commands/inspect';
import { autoUpgradeFromConfig } from 'cli/wiring/auto-upgrade.ts';

import { consoleOutput } from 'cli/output.ts';
import { buildDevDeps } from 'cli/wiring/dev-deps.ts';
import { buildPauseDeps, buildPauseOptions } from 'cli/wiring/pause-deps.ts';
import {
  buildPlatformServiceContext,
  buildServiceUnitRecreate,
  platformServiceUnitPath,
} from 'cli/wiring/platform.ts';
import {
  buildRedactionListDeps,
  buildRedactionListOptions,
  buildRedactionTestDeps,
  buildRedactionTestOptions,
} from 'cli/wiring/redaction-deps.ts';
import { buildRestartDeps } from 'cli/wiring/restart-deps.ts';
import { buildResumeDeps } from 'cli/wiring/resume-deps.ts';
import { buildRunDeps } from 'cli/wiring/run-deps.ts';
import {
  buildSetupDeps,
  buildSetupOptions,
  invokeSetupInteractive,
} from 'cli/wiring/setup-deps.ts';
import { buildStartDeps } from 'cli/wiring/start-deps.ts';
import { buildStatusContext } from 'cli/wiring/status-deps.ts';
import { buildStopDeps } from 'cli/wiring/stop-deps.ts';
import { buildTailDeps, buildTailOptions } from 'cli/wiring/tail-deps.ts';
import { buildUninstallDeps, buildUninstallOptions } from 'cli/wiring/uninstall-deps.ts';
import { buildUpgradeDeps, buildUpgradeOptions } from 'cli/wiring/upgrade-deps.ts';
import { buildVersionString } from 'cli/wiring/version-string.ts';
import { configFilePath, logDir as defaultLogDir } from 'core/io/fs';
import { GatewayError, PACKAGE_DESCRIPTION, PACKAGE_VERSION, UserAbortedError } from 'core/utils';
import { loadConfigFromFile } from 'services/config';

const program = new Command();
program
  .name('proxai-gateway')
  .description(PACKAGE_DESCRIPTION)
  .version(
    buildVersionString({ version: PACKAGE_VERSION, installSourcePath: configFilePath() }),
    '-v, --version',
    'output the version and install source',
  );

function exitUnsupportedPlatform(commandName: string): never {
  console.error(`unsupported platform for ${commandName}: ${process.platform}`);
  process.exit(EXIT_CODE.error);
}

program
  .command('setup')
  .alias('init')
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
  )
  .option(
    '--force',
    're-run setup even if a configuration already exists. Overwrites the stored ingestion key.',
    false,
  )
  .action(
    async (opts: { apiKey?: string; installSource: string; start?: boolean; force?: boolean }) => {
      const ctx = buildPlatformServiceContext(process.platform, process.execPath);
      const setupInputs = {
        platform: process.platform,
        programPath: process.execPath,
        serviceUnitPath: ctx?.unitPath ?? null,
        serviceManager: ctx?.serviceManager ?? null,
        env: process.env,
      };
      const result = await runSetup(buildSetupDeps(setupInputs), buildSetupOptions(opts));
      process.exit(result.exitCode);
    },
  );

program
  .command('start')
  .alias('s')
  .description(
    'Register the gateway as a managed service (launchd / systemd / Scheduled Task) and start the daemon. Auto-restarts on reboot. Requires a prior `setup`.',
  )
  .action(async () => {
    const ctx = buildPlatformServiceContext(process.platform, process.execPath);
    if (ctx === null) exitUnsupportedPlatform('start');
    const setupInputs = {
      platform: ctx.platform,
      programPath: process.execPath,
      serviceUnitPath: ctx.unitPath,
      serviceManager: ctx.serviceManager,
      env: process.env,
    };
    const result = await runStart(
      buildStartDeps({
        serviceManager: ctx.serviceManager,
        serviceUnitRecreate: buildServiceUnitRecreate(
          ctx.platform,
          ctx.unitPath,
          process.execPath,
          process.env,
        ),
        invokeSetup: invokeSetupInteractive(setupInputs),
        runAutoUpgrade: () =>
          autoUpgradeFromConfig({
            binaryPath: process.execPath,
            currentVersion: PACKAGE_VERSION,
            devMode: false,
            loadConfig: () => loadConfigFromFile(),
            exitProcess: () => process.exit(0),
          }),
      }),
    );
    process.exit(result.exitCode);
  });

program
  .command('stop')
  .alias('x')
  .description(
    'Halt the running gateway daemon for this session. The service remains registered and will start again automatically on next reboot. Use `uninstall` to fully decommission.',
  )
  .action(async () => {
    const ctx = buildPlatformServiceContext(process.platform, process.execPath);
    if (ctx === null) exitUnsupportedPlatform('stop');
    const result = await runStop(buildStopDeps(ctx.serviceManager));
    process.exit(result.exitCode);
  });

program
  .command('restart')
  .alias('r')
  .description('Stop and start the gateway daemon. Equivalent to `stop` followed by `start`.')
  .action(async () => {
    const ctx = buildPlatformServiceContext(process.platform, process.execPath);
    if (ctx === null) exitUnsupportedPlatform('restart');
    const setupInputs = {
      platform: ctx.platform,
      programPath: process.execPath,
      serviceUnitPath: ctx.unitPath,
      serviceManager: ctx.serviceManager,
      env: process.env,
    };
    const result = await runRestart(
      buildRestartDeps({
        serviceManager: ctx.serviceManager,
        serviceUnitRecreate: buildServiceUnitRecreate(
          ctx.platform,
          ctx.unitPath,
          process.execPath,
          process.env,
        ),
        invokeSetup: invokeSetupInteractive(setupInputs),
      }),
    );
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
    const result = await runDaemon(
      buildRunDeps({
        config,
        abortSignal: ctrl.signal,
        binaryPath: process.execPath,
        exitProcess: () => process.exit(0),
      }),
    );
    process.exit(result.exitCode);
  });

program
  .command('dev [action]')
  .alias('d')
  .description(
    'Configure or toggle gateway development mode (actions: "on" to force localhost, "off" to restore production, or empty/no option to toggle).',
  )
  .action(async (action?: string) => {
    const result = await runDev(buildDevDeps(), action);
    process.exit(result.exitCode);
  });

program
  .command('status')
  .alias('i')
  .description(
    'Print gateway state: health dot, per-source captures, buffer occupancy, last-cycle drain results, sentinel flags.',
  )
  .option('--config <path>', 'override the default ~/.proxai/proxai-gateway/config.toml path')
  .option('--json', 'emit machine-readable JSON instead of the watch-mode UI', false)
  .option('-v, --verbose', 'show the full breakdown (sources, signals, runtime)', false)
  .action(async (opts: { config?: string; json?: boolean; verbose?: boolean }) => {
    const ctx = buildPlatformServiceContext(process.platform, process.execPath);
    const statusContextInputs: Parameters<typeof buildStatusContext>[0] = {
      json: opts.json === true,
      serviceManager: ctx?.serviceManager ?? null,
      configPath: configFilePath(),
    };
    if (opts.config !== undefined) statusContextInputs.configOverride = opts.config;
    const sCtx = await buildStatusContext(statusContextInputs);
    if (opts.verbose === true) sCtx.options.verbose = true;
    try {
      const result = await runStatus(sCtx.deps, sCtx.options);
      process.exit(result.exitCode);
    } finally {
      sCtx.cleanup();
    }
  });

program
  .command('inspect')
  .alias('ins')
  .description(
    'Dry-run telemetry scanner that compiles records, file counts, and decompressed data sizes without updating buffers.',
  )
  .action(async () => {
    const result = await runInspect({
      output: consoleOutput(),
      configExists: () => Bun.file(configFilePath()).exists(),
      gatewayVersion: PACKAGE_VERSION,
    });
    process.exit(result.exitCode);
  });

program
  .command('pause')
  .description(
    'Pause polling indefinitely by writing a PAUSED sentinel. The daemon keeps running but skips capture cycles. Persists across reboots until cleared with `resume`.',
  )
  .option('--reason <reason>', 'free-form reason recorded in the sentinel file (shown by `status`)')
  .action(async (opts: { reason?: string }) => {
    const result = await runPause(buildPauseDeps(), buildPauseOptions(opts));
    process.exit(result.exitCode);
  });

program
  .command('resume')
  .description('Clear the PAUSED sentinel and resume capture cycles on the next polling tick.')
  .action(async () => {
    const result = await runResume(buildResumeDeps());
    process.exit(result.exitCode);
  });

program
  .command('uninstall')
  .alias('rm')
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
    if (unitPath === null) exitUnsupportedPlatform('uninstall');
    const ctx = buildPlatformServiceContext(platform, process.execPath);
    if (ctx === null) exitUnsupportedPlatform('uninstall');
    const result = await runUninstall(
      buildUninstallDeps({
        platform,
        programPath: process.execPath,
        serviceUnitPath: unitPath,
        serviceManager: ctx.serviceManager,
      }),
      buildUninstallOptions(opts),
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
    const result = await runUpgrade(
      buildUpgradeDeps({ binaryPath: process.execPath }),
      buildUpgradeOptions(opts),
    );
    process.exit(result.exitCode);
  });

program
  .command('tail')
  .alias('t')
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
    'show only entries from one collector. One of: claude-code, cursor, codex, gemini-cli.',
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
      let dir = defaultLogDir();
      try {
        const config = await loadConfigFromFile(opts.config);
        dir = config.logging.logDir;
      } catch {}
      const ctrl = new AbortController();
      process.on('SIGINT', () => ctrl.abort());
      process.on('SIGTERM', () => ctrl.abort());
      const result = await runTail(
        buildTailDeps({ logDir: dir, abortSignal: ctrl.signal }),
        buildTailOptions(opts),
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
    const result = await runRedactionTest(
      buildRedactionTestDeps(),
      buildRedactionTestOptions(filePath, opts),
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
    const result = runRedactionList(buildRedactionListDeps(), buildRedactionListOptions(opts));
    process.exit(result.exitCode);
  });

program.parseAsync().catch((err: unknown) => {
  if (err instanceof UserAbortedError) {
    console.error(`${chalk.red('✗')} aborted ${chalk.dim('— no changes were made')}`);
    process.exit(130);
  }
  if (err instanceof GatewayError) {
    console.error(`${chalk.red('✗')} ${err.message}`);
    process.exit(EXIT_CODE.error);
  }
  if (err instanceof Error) {
    console.error(`${chalk.red('✗')} unexpected error: ${err.message}`);
    if (err.stack !== undefined) console.error(chalk.dim(err.stack));
    process.exit(EXIT_CODE.error);
  }
  console.error(`${chalk.red('✗')} unexpected error: ${String(err)}`);
  process.exit(EXIT_CODE.error);
});
