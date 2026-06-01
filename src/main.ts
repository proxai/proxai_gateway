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
import { runSetup, runSetupNew, runSetupReset } from 'cli/commands/setup';
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

import { inquirerPrompts } from 'cli/prompts.ts';
import { consoleOutput } from 'cli/output.ts';
import { buildDevDeps } from 'cli/wiring/dev-deps.ts';
import { buildDoctorDeps } from 'cli/wiring/doctor-deps.ts';
import { buildLogsDeps } from 'cli/wiring/logs-deps.ts';
import {
  buildPlatformServiceContext,
  buildProfileServiceContext,
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
  resolveSetupServiceContext,
} from 'cli/wiring/setup-deps.ts';
import { buildStartDeps } from 'cli/wiring/start-deps.ts';
import { buildStatusContext } from 'cli/wiring/status-deps.ts';
import { buildStopDeps } from 'cli/wiring/stop-deps.ts';
import { buildTailDeps, buildTailOptions } from 'cli/wiring/tail-deps.ts';
import { buildUninstallDeps, buildUninstallOptions } from 'cli/wiring/uninstall-deps.ts';
import { buildUpgradeDeps } from 'cli/wiring/upgrade-deps.ts';
import { buildVersionString } from 'cli/wiring/version-string.ts';
import { join } from 'node:path';
import { readDevModeSentinel } from 'core/io/fs';
import { buildProfileContext, profileRootDir } from 'core/io/fs/profile.ts';
import type { ProfileName } from 'core/io/fs/profile.types.ts';
import { VALID_PROFILES } from 'core/io/fs/profile.types.ts';
import { GatewayError, PACKAGE_DESCRIPTION, PACKAGE_VERSION, UserAbortedError } from 'core/utils';
import { loadConfigFromFile } from 'services/config';

const isDevMode = await readDevModeSentinel(join(profileRootDir(), 'DEV_MODE'));

const program = new Command();
program
  .name('proxai-gateway')
  .description(PACKAGE_DESCRIPTION)
  .version(
    buildVersionString({
      version: PACKAGE_VERSION,
      installSourcePath: buildProfileContext('prod').configFilePath,
    }),
    '-v, --version',
    'output the version and install source',
  );

program.enablePositionalOptions();

if (isDevMode) {
  program.option('--compact', 'simplified regular user view', false);
}

function exitUnsupportedPlatform(commandName: string): never {
  console.error(`unsupported platform for ${commandName}: ${process.platform}`);
  process.exit(EXIT_CODE.error);
}

function requireDevMode(commandName: string): void {
  if (isDevMode) return;
  console.error(`error: unknown command '${commandName}'`);
  process.exit(EXIT_CODE.error);
}

function parseProfileNameInternal(raw: string | undefined): ProfileName {
  const candidate = (raw ?? 'prod').trim();
  if (candidate === 'prod' || candidate === 'dev') return candidate;
  console.error(`invalid --profile value: '${raw}'. Expected one of: ${VALID_PROFILES.join(', ')}`);
  process.exit(EXIT_CODE.error);
}

function parseProfileName(raw: string | undefined): ProfileName {
  if ((raw ?? 'prod').trim() === 'dev' && !isDevMode) {
    console.error(`invalid --profile value: 'dev'. Expected one of: prod`);
    process.exit(EXIT_CODE.error);
  }
  return parseProfileNameInternal(raw);
}

function withProfileOption(command: Command): Command {
  if (isDevMode) command.option('--profile <name>', 'profile to target (prod | dev)');
  return command;
}

async function resolveSetupInputs(
  profileOpt: string | undefined,
): Promise<Parameters<typeof buildSetupDeps>[0]> {
  let profileName: ProfileName;
  if (isDevMode && profileOpt === undefined) {
    profileName = await inquirerPrompts().askProfile();
  } else {
    const defaultProfile: ProfileName = isDevMode ? 'dev' : 'prod';
    profileName = parseProfileName(profileOpt ?? defaultProfile);
  }
  const profileCtx = buildProfileContext(profileName);
  const serviceContext = resolveSetupServiceContext(process.platform, process.execPath, profileCtx);
  return {
    platform: process.platform,
    programPath: process.execPath,
    serviceUnitPath: serviceContext.serviceUnitPath,
    serviceManager: serviceContext.serviceManager,
    env: process.env,
    profileCtx,
  };
}

const setupCommand = withProfileOption(
  program
    .command('setup [gateway-key]')
    .alias('init')
    .description(
      'Show your gateway configuration, or run first-time setup. Pass a gateway key to configure on the first run (omit it to be prompted). When already configured, prints the gateway key and last upload and points to `setup new` / `setup reset`.',
    )
    .option(
      '--install-source <source>',
      'how this binary was installed; reported to the backend for diagnostics. One of: bun, pnpm, yarn, npm, brew, github_release.',
      'github_release',
    )
    .option(
      '--no-start',
      'finish setup without registering or starting the platform service. Run `proxai-gateway start` manually when ready.',
    ),
).action(
  async (
    gatewayKey: string | undefined,
    opts: { installSource: string; start?: boolean; profile?: string },
  ) => {
    const inputs = await resolveSetupInputs(opts.profile);
    const optionsForRun = gatewayKey === undefined ? opts : { ...opts, apiKey: gatewayKey };
    const result = await runSetup(buildSetupDeps(inputs), buildSetupOptions(optionsForRun));
    process.exit(result.exitCode);
  },
);

withProfileOption(
  setupCommand
    .command('new [gateway-key]')
    .description(
      'Replace the stored gateway key with a new one: re-verifies the key, rewrites the configuration, clears any auth-failure flag, and restarts the daemon. Pass the key as an argument, or run with no argument to be prompted for it.',
    )
    .option(
      '--install-source <source>',
      'how this binary was installed; reported to the backend for diagnostics.',
      'github_release',
    )
    .option('--no-start', 'finish without registering or starting the platform service.'),
).action(
  async (
    gatewayKey: string | undefined,
    opts: { installSource: string; start?: boolean; profile?: string },
  ) => {
    const inputs = await resolveSetupInputs(opts.profile);
    const optionsForRun = gatewayKey === undefined ? opts : { ...opts, apiKey: gatewayKey };
    const result = await runSetupNew(buildSetupDeps(inputs), buildSetupOptions(optionsForRun));
    process.exit(result.exitCode);
  },
);

withProfileOption(
  setupCommand
    .command('reset')
    .description(
      'Stop the daemon and remove the stored gateway key, returning the gateway to a waiting-for-configuration state. Buffered data and logs are kept.',
    )
    .option('-y, --yes', 'skip the confirmation prompt', false),
).action(async (opts: { yes?: boolean; profile?: string }) => {
  const inputs = await resolveSetupInputs(opts.profile);
  const result = await runSetupReset(buildSetupDeps(inputs), { yes: opts.yes === true });
  process.exit(result.exitCode);
});

withProfileOption(
  program
    .command('start')
    .alias('s')
    .description(
      'Register the gateway as a managed service (launchd / systemd / Scheduled Task) and start the daemon. Auto-restarts on reboot. Requires a prior `setup`.',
    ),
).action(async (opts: { profile?: string }) => {
  const profileCtx = buildProfileContext(parseProfileName(opts.profile));
  const ctx = buildProfileServiceContext(process.platform, process.execPath, profileCtx);
  if (ctx === null) exitUnsupportedPlatform('start');
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

withProfileOption(
  program
    .command('stop')
    .alias('x')
    .description(
      'Halt the running gateway daemon for this session. The service remains registered and will start again automatically on next reboot. Use `uninstall` to fully decommission.',
    ),
).action(async (opts: { profile?: string }) => {
  const profileCtx = buildProfileContext(parseProfileName(opts.profile));
  const ctx = buildProfileServiceContext(process.platform, process.execPath, profileCtx);
  if (ctx === null) exitUnsupportedPlatform('stop');
  const result = await runStop(
    buildStopDeps({
      serviceManager: ctx.serviceManager,
      profileCtx,
    }),
  );
  process.exit(result.exitCode);
});

withProfileOption(
  program
    .command('restart')
    .alias('r')
    .description('Stop and start the gateway daemon. Equivalent to `stop` followed by `start`.'),
).action(async (opts: { profile?: string }) => {
  const profileCtx = buildProfileContext(parseProfileName(opts.profile));
  const ctx = buildProfileServiceContext(process.platform, process.execPath, profileCtx);
  if (ctx === null) exitUnsupportedPlatform('restart');
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
    const profileName = parseProfileNameInternal(opts.profile);
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
  .command('dev [action] [key]', { hidden: !isDevMode })
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

withProfileOption(
  program
    .command('xstate', { hidden: !isDevMode })
    .description(
      'Start the gateway daemon in the foreground with the Stately browser visualizer enabled.',
    )
    .option('--config <path>', 'override the default ~/.proxai/proxai-gateway/config.toml path'),
).action(async (opts: { config?: string; profile?: string }) => {
  requireDevMode('xstate');
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

const statusCommand = withProfileOption(
  program
    .command('status')
    .alias('i')
    .description(
      'Print gateway state: health dot, per-source captures, buffer occupancy, last-cycle drain results, sentinel flags.',
    )
    .option('--config <path>', 'override the default ~/.proxai/proxai-gateway/config.toml path')
    .option('--json', 'emit machine-readable JSON instead of the watch-mode UI', false),
);

if (isDevMode) {
  statusCommand.option('--all', 'show both prod and dev profiles side-by-side', false);
  statusCommand.option('--compact', 'simplified regular user view', false);
}

statusCommand.action(
  async (opts: {
    config?: string;
    json?: boolean;
    profile?: string;
    all?: boolean;
    compact?: boolean;
  }) => {
    const compactMode = opts.compact === true || program.opts().compact === true;
    const profileCtx = buildProfileContext(parseProfileName(opts.profile));
    const ctx = buildProfileServiceContext(process.platform, process.execPath, profileCtx);
    const statusContextInputs: Parameters<typeof buildStatusContext>[0] = {
      profileCtx,
      json: opts.json === true,
      serviceManager: ctx?.serviceManager ?? null,
      configPath: profileCtx.configFilePath,
    };
    if (opts.config !== undefined) statusContextInputs.configOverride = opts.config;
    const sCtx = await buildStatusContext(statusContextInputs);
    let devCleanup: (() => void) | null = null;
    try {
      if ((opts.all === true || isDevMode) && !compactMode) {
        const devProfileCtx = buildProfileContext('dev');
        const devServiceCtx = buildProfileServiceContext(
          process.platform,
          process.execPath,
          devProfileCtx,
        );
        const devCtx = await buildStatusContext({
          profileCtx: devProfileCtx,
          json: opts.json === true,
          serviceManager: devServiceCtx?.serviceManager ?? null,
          configPath: devProfileCtx.configFilePath,
        });
        devCleanup = devCtx.cleanup;
        sCtx.options.devDeps = devCtx.deps;
      }
      if (opts.all === true) sCtx.options.all = true;
      sCtx.options.compact = compactMode;
      const result = await runStatus(sCtx.deps, sCtx.options);
      process.exit(result.exitCode);
    } finally {
      sCtx.cleanup();
      if (devCleanup !== null) devCleanup();
    }
  },
);

withProfileOption(
  program
    .command('inspect', { hidden: !isDevMode })
    .alias('ins')
    .description(
      'Dry-run telemetry scanner that compiles records, file counts, and decompressed data sizes without updating buffers.',
    ),
).action(async (opts: { profile?: string }) => {
  requireDevMode('inspect');
  const profileCtx = buildProfileContext(parseProfileName(opts.profile));
  const result = await runInspect({
    output: consoleOutput(),
    configExists: () => Bun.file(profileCtx.configFilePath).exists(),
    gatewayVersion: PACKAGE_VERSION,
  });
  process.exit(result.exitCode);
});

withProfileOption(
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
    .option('-y, --yes', 'skip the interactive confirmation prompt for `--reset`', false),
).action(async (opts: { reset?: boolean; yes?: boolean; profile?: string }) => {
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

withProfileOption(
  program
    .command('upgrade')
    .alias('update')
    .description(
      'Fetch the latest gateway release from GitHub and replace the running binary. On Windows, writes the new binary alongside the existing one (restart required to apply).',
    )
    .option(
      '--force',
      'install the latest release even when it is not detected as newer than the current version',
      false,
    ),
).action(async (opts: { profile?: string; force?: boolean }) => {
  const result = await runUpgrade(buildUpgradeDeps({ binaryPath: process.execPath }), {
    force: opts.force === true,
  });
  process.exit(result.exitCode);
});

withProfileOption(
  program
    .command('tail', { hidden: !isDevMode })
    .alias('t')
    .description(
      'Stream structured (ndjson) log entries from the active gateway log file. Defaults to live watch mode; use --static for one-shot output.',
    )
    .option('--lines <n>', 'number of trailing entries to print before applying filters', '50')
    .option(
      '--static',
      'one-shot output: print trailing lines and exit without watching for new entries',
      false,
    )
    .option(
      '--source <name>',
      'show only entries from one collector. One of: claude-code, cursor, codex, claude-desktop.',
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
    .option('--config <path>', 'override the default ~/.proxai/proxai-gateway/config.toml path'),
).action(
  async (opts: {
    lines?: string;
    static?: boolean;
    source?: string;
    level?: string;
    since?: string;
    raw?: boolean;
    config?: string;
    profile?: string;
  }) => {
    requireDevMode('tail');
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
  .command('redaction', { hidden: !isDevMode })
  .description('Inspect the on-device secret-redaction rules and try them against a sample file.');

withProfileOption(
  redaction
    .command('test <file>')
    .description(
      'Run the full redaction pipeline against a local file and print what would be uploaded. The file is never sent anywhere; this is a local-only dry run.',
    )
    .option(
      '--show-rules',
      'after the redacted output, print a summary of which rules matched and how many times',
      false,
    ),
).action(async (filePath: string, opts: { showRules?: boolean; profile?: string }) => {
  requireDevMode('redaction');
  parseProfileName(opts.profile);
  const result = await runRedactionTest(
    buildRedactionTestDeps(),
    buildRedactionTestOptions(filePath, opts),
  );
  process.exit(result.exitCode);
});

withProfileOption(
  program
    .command('replay <logPath>', { hidden: !isDevMode })
    .description(
      'Replay a JSONL log of state-machine transitions and print the final state per machine. Useful for incident debugging.',
    )
    .option('--machine <name>', 'limit the replay to a single machine'),
).action(async (logPath: string, opts: { machine?: string; profile?: string }) => {
  requireDevMode('replay');
  parseProfileName(opts.profile);
  const replayOptions: { logPath: string; machine?: string } = { logPath };
  if (opts.machine !== undefined) replayOptions.machine = opts.machine;
  const result = await runReplay(defaultReplayDeps, replayOptions);
  process.exit(result.exitCode);
});

withProfileOption(
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
    ),
).action((opts: { categories?: boolean; category?: string; json?: boolean; profile?: string }) => {
  requireDevMode('redaction');
  parseProfileName(opts.profile);
  const result = runRedactionList(buildRedactionListDeps(), buildRedactionListOptions(opts));
  process.exit(result.exitCode);
});

const logsCommand = withProfileOption(
  program
    .command('logs')
    .description(
      'Show your last uploaded records (and failed or pending ones) from the local buffer.',
    )
    .option('--static', 'one-shot output, no live refresh', false)
    .option('--json', 'emit JSON; implies --static', false)
    .option('--failed', 'show failed and quarantined records instead of uploaded', false)
    .option('--pending', 'show queued records not yet uploaded', false)
    .option(
      '-v, --verbose',
      'expand every record to its full prompt, response, and metadata',
      false,
    )
    .option('--id <capture-id>', 'show full detail for one record by capture id (prefix accepted)')
    .option('--source <app>', 'filter by coding agent (claude-code, cursor, codex, claude-desktop)')
    .option('--since <dur>', 'show records from the last duration (e.g. 24h, 7d)')
    .option('--lines <n>', 'number of records to display', '50'),
);

logsCommand.action(
  async (opts: {
    static?: boolean;
    json?: boolean;
    failed?: boolean;
    pending?: boolean;
    verbose?: boolean;
    id?: string;
    source?: string;
    since?: string;
    lines?: string;
    profile?: string;
  }) => {
    const defaultProfile: ProfileName = isDevMode ? 'dev' : 'prod';
    const profileName = parseProfileName(opts.profile ?? defaultProfile);
    const profileCtx = buildProfileContext(profileName);
    const { deps, cleanup } = await buildLogsDeps({ bufferPath: profileCtx.bufferDbPath });
    const ctrl = new AbortController();
    process.on('SIGINT', () => ctrl.abort());
    process.on('SIGTERM', () => ctrl.abort());
    try {
      const parsedLines = opts.lines !== undefined ? parseInt(opts.lines, 10) : 50;
      const safeLines = Number.isFinite(parsedLines) ? parsedLines : 50;
      const result = await runLogs(deps, {
        lines: safeLines,
        ...(opts.static === true ? { static: true as const } : {}),
        ...(opts.json === true ? { json: true as const } : {}),
        ...(opts.failed === true ? { failed: true as const } : {}),
        ...(opts.pending === true ? { pending: true as const } : {}),
        ...(opts.verbose === true ? { verbose: true as const } : {}),
        ...(opts.id !== undefined ? { id: opts.id } : {}),
        ...(opts.source !== undefined ? { source: opts.source } : {}),
        ...(opts.since !== undefined ? { since: opts.since } : {}),
      });
      process.exit(result.exitCode);
    } finally {
      cleanup();
    }
  },
);

const doctorCommand = withProfileOption(
  program
    .command('doctor')
    .description(
      'Diagnose common failure scenarios and report findings with copy-pasteable output.',
    )
    .option(
      '-o, --output [path]',
      'Output diagnostic report to an HTML file (absolute or relative, default: Desktop)',
    ),
);

doctorCommand.action(async (opts: { profile?: string; output?: string | boolean }) => {
  const defaultProfile: ProfileName = isDevMode ? 'dev' : 'prod';
  const profileName = parseProfileName(opts.profile ?? defaultProfile);
  const profileCtx = buildProfileContext(profileName);
  const platform = process.platform;
  const serviceManager =
    buildProfileServiceContext(platform, process.execPath, profileCtx)?.serviceManager ?? null;
  const result = await runDoctor(buildDoctorDeps({ serviceManager, platform, profileCtx }), {
    profile: opts.profile,
    output: opts.output,
  });
  process.exit(result.exitCode);
});

function hideProfileOptions(command: Command): void {
  for (const option of command.options) {
    if (option.long === '--profile') {
      option.hideHelp(true);
    }
  }
  for (const sub of command.commands) {
    hideProfileOptions(sub);
  }
}

if (!isDevMode) {
  hideProfileOptions(program);
}

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
