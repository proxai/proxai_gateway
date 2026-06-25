import type { Command } from 'commander';
import type { CLIContext } from 'cli/program/context.ts';
import { runStatus } from 'cli/commands/status';
import { runInspect } from 'cli/commands/inspect';
import { runTail } from 'cli/commands/tail';
import { runLogs } from 'cli/commands/logs';
import { runDoctor } from 'cli/commands/doctor';
import { buildStatusContext } from 'cli/wiring/status-deps.ts';
import { buildTailDeps, buildTailOptions } from 'cli/wiring/tail-deps.ts';
import { buildLogsDeps } from 'cli/wiring/logs-deps.ts';
import { buildDoctorDeps } from 'cli/wiring/doctor-deps.ts';
import { buildProfileServiceContext } from 'cli/wiring/platform.ts';
import { buildProfileContext } from 'core/io/fs/profile.ts';
import type { ProfileName } from 'core/io/fs/profile.types.ts';
import { loadConfigFromFile } from 'services/config';
import { consoleOutput } from 'cli/output.ts';
import { PACKAGE_VERSION } from 'core/utils';
import { parseProfileName, requireDevMode, withProfileOption } from 'cli/program/context.ts';

export function registerDiagnosticsCommands(program: Command, ctx: CLIContext): void {
  const statusCommand = withProfileOption(
    program
      .command('status')
      .alias('i')
      .description(
        'Print gateway state: health dot, per-source captures, buffer occupancy, last-cycle drain results, sentinel flags.',
      )
      .option('--config <path>', 'override the default ~/.proxai/proxai-gateway/config.toml path')
      .option('--json', 'emit machine-readable JSON instead of the watch-mode UI', false),
    ctx.isDevMode,
  );

  if (ctx.isDevMode) {
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
      const profileCtx = buildProfileContext(parseProfileName(opts.profile, ctx.isDevMode));
      const serviceCtx = buildProfileServiceContext(process.platform, process.execPath, profileCtx);
      const statusContextInputs: Parameters<typeof buildStatusContext>[0] = {
        profileCtx,
        json: opts.json === true,
        serviceManager: serviceCtx?.serviceManager ?? null,
        configPath: profileCtx.configFilePath,
      };
      if (opts.config !== undefined) statusContextInputs.configOverride = opts.config;
      const sCtx = await buildStatusContext(statusContextInputs);
      let devCleanup: (() => void) | null = null;
      try {
        if ((opts.all === true || ctx.isDevMode) && !compactMode) {
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
      .command('inspect', { hidden: !ctx.isDevMode })
      .alias('ins')
      .description(
        'Dry-run telemetry scanner that compiles records, file counts, and decompressed data sizes without updating buffers.',
      ),
    ctx.isDevMode,
  ).action(async (opts: { profile?: string }) => {
    requireDevMode('inspect', ctx.isDevMode);
    const profileCtx = buildProfileContext(parseProfileName(opts.profile, ctx.isDevMode));
    const result = await runInspect({
      output: consoleOutput(),
      configExists: () => Bun.file(profileCtx.configFilePath).exists(),
      gatewayVersion: PACKAGE_VERSION,
    });
    process.exit(result.exitCode);
  });

  withProfileOption(
    program
      .command('tail', { hidden: !ctx.isDevMode })
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
        'show only entries from one collector. One of: claude-code, cursor, codex, claude-desktop, gemini.',
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
    ctx.isDevMode,
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
      requireDevMode('tail', ctx.isDevMode);
      const profileCtx = buildProfileContext(parseProfileName(opts.profile, ctx.isDevMode));
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
      .option(
        '--id <capture-id>',
        'show full detail for one record by capture id (prefix accepted)',
      )
      .option(
        '--source <app>',
        'filter by coding agent (claude-code, cursor, codex, claude-desktop, gemini)',
      )
      .option('--since <dur>', 'show records from the last duration (e.g. 24h, 7d)')
      .option('--lines <n>', 'number of records to display', '50'),
    ctx.isDevMode,
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
      const defaultProfile: ProfileName = ctx.isDevMode ? 'dev' : 'prod';
      const profileName = parseProfileName(opts.profile ?? defaultProfile, ctx.isDevMode);
      const profileCtx = buildProfileContext(profileName);
      const { deps, cleanup } = await buildLogsDeps({ profileCtx });
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
    ctx.isDevMode,
  );

  doctorCommand.action(async (opts: { profile?: string; output?: string | boolean }) => {
    const defaultProfile: ProfileName = ctx.isDevMode ? 'dev' : 'prod';
    const profileName = parseProfileName(opts.profile ?? defaultProfile, ctx.isDevMode);
    const profileCtx = buildProfileContext(profileName);
    const platform = process.platform;
    const serviceCtx = buildProfileServiceContext(platform, process.execPath, profileCtx);
    const serviceManager = serviceCtx?.serviceManager ?? null;
    const result = await runDoctor(
      await buildDoctorDeps({ serviceManager, platform, profileCtx }),
      {
        profile: opts.profile,
        output: opts.output,
      },
    );
    process.exit(result.exitCode);
  });
}
