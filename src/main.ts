#!/usr/bin/env bun
import chalk from 'chalk';
import { Command } from 'commander';

import { EXIT_CODE } from 'cli/cli.constants.ts';

import { runDev } from 'cli/commands/dev.ts';
import { runLogs } from 'cli/commands/logs';
import { runDoctor } from 'cli/commands/doctor';
import { runRedactionList, runRedactionTest } from 'cli/commands/redaction.ts';
import { runRestart } from 'cli/commands/restart.ts';
import { runDaemon } from 'cli/commands/run';
import { refreshServiceUnitIfLegacy } from 'cli/commands/run/service-unit-refresh.ts';
import { runDaemonStartupRelocation } from 'cli/commands/run/startup-relocation.ts';
import { runSetup } from 'cli/commands/setup';
import { runStart } from 'cli/commands/start.ts';
import { runStatus } from 'cli/commands/status';
import { runStop } from 'cli/commands/stop.ts';
import { runTail } from 'cli/commands/tail';
import { runUninstall } from 'cli/commands/uninstall';
import { runUpgrade } from 'cli/commands/upgrade.ts';
import { runInspect } from 'cli/commands/inspect';
import { defaultReplayDeps, runReplay } from 'cli/commands/replay';
import { runUpgradePostRespawnRestore } from 'services/upgrade/coordinated-upgrade.ts';
import { autoUpgradeFromConfig } from 'cli/wiring/auto-upgrade.ts';
import { buildUpgradePostRespawnRestoreDeps } from 'cli/wiring/upgrade-restore-deps.ts';

import { consoleOutput } from 'cli/output.ts';
import { buildDevDeps } from 'cli/wiring/dev-deps.ts';
import { buildDoctorDeps } from 'cli/wiring/doctor-deps.ts';
import { buildLogsDeps } from 'cli/wiring/logs-deps.ts';
import {
  buildPlatformServiceContext,
  buildServiceUnitRecreate,
  platformServiceUnitPath,
  resolveWindowsUserId,
} from 'cli/wiring/platform.ts';
import {
  buildRedactionListDeps,
  buildRedactionListOptions,
  buildRedactionTestDeps,
  buildRedactionTestOptions,
} from 'cli/wiring/redaction-deps.ts';
import { buildRestartDeps } from 'cli/wiring/restart-deps.ts';
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
import { buildUpgradeDeps } from 'cli/wiring/upgrade-deps.ts';
import { buildVersionString } from 'cli/wiring/version-string.ts';
import { join } from 'node:path';
import { configFilePath, readDevModeSentinel } from 'core/io/fs';
import { buildProfileContext, profileRootDir } from 'core/io/fs/profile.ts';
import type { ProfileName } from 'core/io/fs/profile.types.ts';
import { VALID_PROFILES } from 'core/io/fs/profile.types.ts';
import { GatewayError, PACKAGE_DESCRIPTION, PACKAGE_VERSION, UserAbortedError } from 'core/utils';
import { loadConfigFromFile } from 'services/config';

const godMode = await readDevModeSentinel(join(profileRootDir(), 'DEV_MODE'));

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

function parseProfileName(raw: string | undefined): ProfileName {
  const candidate = (raw ?? 'prod').trim();
  if (candidate === 'prod' || candidate === 'dev') return candidate;
  console.error(`invalid --profile value: '${raw}'. Expected one of: ${VALID_PROFILES.join(', ')}`);
  process.exit(EXIT_CODE.error);
}

program
  .command('setup')
  .alias('init')
  .description(
    'Configure the gateway with your ingestion key. Verifies the key, writes ~/.proxai/proxai-gateway/config.toml, installs the platform service unit, and starts the daemon. If the machine is already configured, starts the daemon when it is not running.',
  )
  .argument(
    '[api-key]',
    'ingestion key to verify and store; equivalent to --api-key. If a different key is already configured, you will be prompted to replace it.',
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
  .option('--profile <name>', 'profile to target (prod | dev)')
  .action(
    async (
      positionalApiKey: string | undefined,
      opts: {
        apiKey?: string;
        installSource: string;
        start?: boolean;
        force?: boolean;
        profile?: string;
      },
    ) => {
      const defaultProfile: ProfileName = godMode ? 'dev' : 'prod';
      const profileName = parseProfileName(opts.profile ?? defaultProfile);
      const ctx = buildPlatformServiceContext(process.platform, process.execPath);
      const profileCtx = buildProfileContext(profileName);
      const setupInputs = {
        platform: process.platform,
        programPath: process.execPath,
        serviceUnitPath: ctx?.unitPath ?? null,
        serviceManager: ctx?.serviceManager ?? null,
        env: process.env,
        profileCtx,
      };
      const effectiveKey = positionalApiKey ?? opts.apiKey;
      const optionsForRun: typeof opts =
        effectiveKey === undefined ? opts : { ...opts, apiKey: effectiveKey };
      const result = await runSetup(buildSetupDeps(setupInputs), buildSetupOptions(optionsForRun));
      process.exit(result.exitCode);
    },
  );

program
  .command('start')
  .alias('s')
  .description(
    'Register the gateway as a managed service (launchd / systemd / Scheduled Task) and start the daemon. Auto-restarts on reboot. Requires a prior `setup`.',
  )
  .option('--profile <name>', 'profile to target (prod | dev)', 'prod')
  .action(async (opts: { profile?: string }) => {
    const ctx = buildPlatformServiceContext(process.platform, process.execPath);
    if (ctx === null) exitUnsupportedPlatform('start');
    const profileCtx = buildProfileContext(parseProfileName(opts.profile));
    const setupInputs = {
      platform: ctx.platform,
      programPath: process.execPath,
      serviceUnitPath: ctx.unitPath,
      serviceManager: ctx.serviceManager,
      env: process.env,
      profileCtx,
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
            loadConfig: () => loadConfigFromFile(profileCtx.configFilePath),
            exitProcess: () => process.exit(0),
          }),
        profileCtx,
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
  .option('--profile <name>', 'profile to target (prod | dev)', 'prod')
  .action(async (opts: { profile?: string }) => {
    const ctx = buildPlatformServiceContext(process.platform, process.execPath);
    if (ctx === null) exitUnsupportedPlatform('stop');
    const result = await runStop(
      buildStopDeps({
        serviceManager: ctx.serviceManager,
        profileCtx: buildProfileContext(parseProfileName(opts.profile)),
      }),
    );
    process.exit(result.exitCode);
  });

program
  .command('restart')
  .alias('r')
  .description('Stop and start the gateway daemon. Equivalent to `stop` followed by `start`.')
  .option('--profile <name>', 'profile to target (prod | dev)', 'prod')
  .action(async (opts: { profile?: string }) => {
    const ctx = buildPlatformServiceContext(process.platform, process.execPath);
    if (ctx === null) exitUnsupportedPlatform('restart');
    const profileCtx = buildProfileContext(parseProfileName(opts.profile));
    const setupInputs = {
      platform: ctx.platform,
      programPath: process.execPath,
      serviceUnitPath: ctx.unitPath,
      serviceManager: ctx.serviceManager,
      env: process.env,
      profileCtx,
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
        profileCtx,
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
  .option('--profile <name>', 'profile to run as (prod | dev)', 'prod')
  .action(async (opts: { config?: string; profile?: string }) => {
    await runDaemonStartupRelocation();
    const profileName = parseProfileName(opts.profile);
    const profileCtx = buildProfileContext(profileName);
    const platformCtx = buildPlatformServiceContext(process.platform, process.execPath);
    if (platformCtx !== null) {
      const windowsUserId =
        platformCtx.platform === 'win32' ? resolveWindowsUserId(process.env) : undefined;
      const refreshConfig =
        windowsUserId !== undefined
          ? {
              serviceUnitPath: platformCtx.unitPath,
              programPath: process.execPath,
              platform: platformCtx.platform,
              profileName,
              windowsUserId,
            }
          : {
              serviceUnitPath: platformCtx.unitPath,
              programPath: process.execPath,
              platform: platformCtx.platform,
              profileName,
            };
      await refreshServiceUnitIfLegacy(refreshConfig);
    }
    if (!profileCtx.isDev) {
      try {
        await runUpgradePostRespawnRestore(
          buildUpgradePostRespawnRestoreDeps({ platform: process.platform }),
        );
      } catch {}
    }
    const config = await loadConfigFromFile(opts.config ?? profileCtx.configFilePath);
    const ctrl = new AbortController();
    process.on('SIGINT', () => ctrl.abort());
    process.on('SIGTERM', () => ctrl.abort());
    const result = await runDaemon(
      buildRunDeps({
        config,
        abortSignal: ctrl.signal,
        binaryPath: process.execPath,
        exitProcess: () => process.exit(EXIT_CODE.upgradeRespawn),
        profileCtx,
      }),
    );
    process.exit(result.exitCode);
  });

program
  .command('dev [action] [key]', { hidden: !godMode })
  .alias('d')
  .description(
    'Manage gateway development mode. Actions: "on", "off", "setup <KEY>", or no action to toggle.',
  )
  .action(async (action?: string, key?: string) => {
    const result = await runDev(
      buildDevDeps(),
      action,
      key !== undefined ? { apiKey: key } : undefined,
    );
    process.exit(result.exitCode);
  });

program
  .command('xstate', { hidden: !godMode })
  .description(
    'Start the gateway daemon in the foreground with the Stately browser visualizer enabled (only available in development mode).',
  )
  .option('--config <path>', 'override the default ~/.proxai/proxai-gateway/config.toml path')
  .option('--profile <name>', 'profile to target (prod | dev)', 'prod')
  .action(async (opts: { config?: string; profile?: string }) => {
    if (!godMode) {
      console.error(
        chalk.red(
          'Error: "xstate" command is only available in development mode.\n' +
            'Please run "proxai-gateway dev on" first to activate development mode.',
        ),
      );
      process.exit(EXIT_CODE.error);
    }

    const profileCtx = buildProfileContext(parseProfileName(opts.profile));
    const config = await loadConfigFromFile(opts.config ?? profileCtx.configFilePath);
    const ctrl = new AbortController();
    process.on('SIGINT', () => ctrl.abort());
    process.on('SIGTERM', () => ctrl.abort());

    const result = await runDaemon(
      buildRunDeps({
        config,
        abortSignal: ctrl.signal,
        binaryPath: process.execPath,
        exitProcess: () => process.exit(EXIT_CODE.upgradeRespawn),
        xstateInspect: true,
        profileCtx,
      }),
    );
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
  .option('--profile <name>', 'profile to target (prod | dev)', 'prod')
  .action(async (opts: { config?: string; json?: boolean; profile?: string }) => {
    const ctx = buildPlatformServiceContext(process.platform, process.execPath);
    const profileCtx = buildProfileContext(parseProfileName(opts.profile));
    const statusContextInputs: Parameters<typeof buildStatusContext>[0] = {
      profileCtx,
      json: opts.json === true,
      serviceManager: ctx?.serviceManager ?? null,
      configPath: profileCtx.configFilePath,
    };
    if (opts.config !== undefined) statusContextInputs.configOverride = opts.config;
    const sCtx = await buildStatusContext(statusContextInputs);
    try {
      const result = await runStatus(sCtx.deps, sCtx.options);
      process.exit(result.exitCode);
    } finally {
      sCtx.cleanup();
    }
  });

program
  .command('inspect', { hidden: !godMode })
  .alias('ins')
  .description(
    'Dry-run telemetry scanner that compiles records, file counts, and decompressed data sizes without updating buffers.',
  )
  .option('--profile <name>', 'profile to target (prod | dev)', 'prod')
  .action(async (opts: { profile?: string }) => {
    const profileCtx = buildProfileContext(parseProfileName(opts.profile));
    const result = await runInspect({
      output: consoleOutput(),
      configExists: () => Bun.file(profileCtx.configFilePath).exists(),
      gatewayVersion: PACKAGE_VERSION,
    });
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
  .option('--profile <name>', 'profile to target (prod | dev)', 'prod')
  .action(async (opts: { reset?: boolean; yes?: boolean; profile?: string }) => {
    const platform = process.platform;
    const profileCtx = buildProfileContext(parseProfileName(opts.profile));
    const unitPath = platformServiceUnitPath(platform, profileCtx.configDir);
    if (unitPath === null) exitUnsupportedPlatform('uninstall');
    const ctx = buildPlatformServiceContext(platform, process.execPath, profileCtx.configDir);
    if (ctx === null) exitUnsupportedPlatform('uninstall');
    const result = await runUninstall(
      buildUninstallDeps({
        platform,
        programPath: process.execPath,
        serviceUnitPath: unitPath,
        serviceManager: ctx.serviceManager,
        profileCtx,
      }),
      buildUninstallOptions(opts),
    );
    process.exit(result.exitCode);
  });

program
  .command('upgrade')
  .alias('update')
  .description(
    'Fetch the latest gateway release from GitHub and replace the running binary. On Windows, writes the new binary alongside the existing one (restart required to apply).',
  )
  .option('--profile <name>', 'profile to target (prod | dev)', 'prod')
  .action(async (_opts: { profile?: string }) => {
    const result = await runUpgrade(buildUpgradeDeps({ binaryPath: process.execPath }));
    process.exit(result.exitCode);
  });

program
  .command('tail', { hidden: !godMode })
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
  .option('--profile <name>', 'profile to target (prod | dev)', 'prod')
  .action(
    async (opts: {
      lines?: string;
      follow?: boolean;
      source?: string;
      level?: string;
      since?: string;
      raw?: boolean;
      config?: string;
      profile?: string;
    }) => {
      const profileCtx = buildProfileContext(parseProfileName(opts.profile));
      let dir = profileCtx.logDir;
      try {
        const config = await loadConfigFromFile(opts.config ?? profileCtx.configFilePath);
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
  .command('redaction', { hidden: !godMode })
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
  .option('--profile <name>', 'profile to target (prod | dev)', 'prod')
  .action(async (filePath: string, opts: { showRules?: boolean; profile?: string }) => {
    parseProfileName(opts.profile);
    const result = await runRedactionTest(
      buildRedactionTestDeps(),
      buildRedactionTestOptions(filePath, opts),
    );
    process.exit(result.exitCode);
  });

program
  .command('replay <logPath>', { hidden: !godMode })
  .description(
    'Replay a JSONL log of state-machine transitions and print the final state per machine. Useful for incident debugging.',
  )
  .option('--machine <name>', 'limit the replay to a single machine')
  .option('--profile <name>', 'profile to target (prod | dev)', 'prod')
  .action(async (logPath: string, opts: { machine?: string; profile?: string }) => {
    parseProfileName(opts.profile);
    const replayOptions: { logPath: string; machine?: string } = { logPath };
    if (opts.machine !== undefined) replayOptions.machine = opts.machine;
    const result = await runReplay(defaultReplayDeps, replayOptions);
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
  .option('--profile <name>', 'profile to target (prod | dev)', 'prod')
  .action((opts: { categories?: boolean; category?: string; json?: boolean; profile?: string }) => {
    parseProfileName(opts.profile);
    const result = runRedactionList(buildRedactionListDeps(), buildRedactionListOptions(opts));
    process.exit(result.exitCode);
  });

program
  .command('logs')
  .description('Show uploaded records and any errors from the local buffer.')
  .option('--static', 'one-shot output, no live refresh', false)
  .option('--json', 'emit JSON; implies --static', false)
  .option('--error', 'show only failed, quarantined, and looping-resync records', false)
  .option('--source <app>', 'filter by coding agent (claude-code, cursor, codex, gemini-cli)')
  .option('--since <dur>', 'show records from the last duration (e.g. 24h, 7d)')
  .option('--pending', 'show queued records not yet uploaded', false)
  .option('--lines <n>', 'number of records to display', '20')
  .option('--profile <name>', 'profile to query (prod | dev)')
  .action(
    async (opts: {
      static?: boolean;
      json?: boolean;
      error?: boolean;
      source?: string;
      since?: string;
      pending?: boolean;
      lines?: string;
      profile?: string;
    }) => {
      const defaultProfile: ProfileName = godMode ? 'dev' : 'prod';
      const profileName = parseProfileName(opts.profile ?? defaultProfile);
      const profileCtx = buildProfileContext(profileName);
      const { deps, cleanup } = await buildLogsDeps({ bufferPath: profileCtx.bufferDbPath });
      const ctrl = new AbortController();
      process.on('SIGINT', () => ctrl.abort());
      process.on('SIGTERM', () => ctrl.abort());
      try {
        const parsedLines = opts.lines !== undefined ? parseInt(opts.lines, 10) : 20;
        const safeLines = Number.isFinite(parsedLines) ? parsedLines : 20;
        const result = await runLogs(deps, {
          lines: safeLines,
          ...(opts.static === true ? { static: true as const } : {}),
          ...(opts.json === true ? { json: true as const } : {}),
          ...(opts.error === true ? { error: true as const } : {}),
          ...(opts.pending === true ? { pending: true as const } : {}),
          ...(opts.source !== undefined ? { source: opts.source } : {}),
          ...(opts.since !== undefined ? { since: opts.since } : {}),
        });
        process.exit(result.exitCode);
      } finally {
        cleanup();
      }
    },
  );

program
  .command('doctor')
  .description('Diagnose common failure scenarios and report findings with copy-pasteable output.')
  .option('--profile <name>', 'profile to diagnose (prod | dev)')
  .action(async (opts: { profile?: string }) => {
    const defaultProfile: ProfileName = godMode ? 'dev' : 'prod';
    const profileName = parseProfileName(opts.profile ?? defaultProfile);
    const profileCtx = buildProfileContext(profileName);
    const platform = process.platform;
    const unitPath = platformServiceUnitPath(platform, profileCtx.configDir);
    const serviceManager =
      unitPath !== null
        ? (buildPlatformServiceContext(platform, process.execPath, profileCtx.configDir)
            ?.serviceManager ?? null)
        : null;
    const result = await runDoctor(
      buildDoctorDeps({ serviceManager, platform, profileCtx }),
      opts.profile !== undefined ? { profile: opts.profile } : {},
    );
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
