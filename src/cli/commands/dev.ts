import type { Logger, LoggerFactoryOptions } from 'core/log';
import { EXIT_CODE } from 'cli/cli.constants.ts';
import type { CommandResult, OutputSink } from 'cli/cli.types.ts';
import type { RunCommandDeps } from 'cli/commands/run.ts';
import type { GatewayConfig } from 'services/config';

export const DEV_NEST_URL = 'http://localhost:3001';

export interface DevCommandDeps {
  output: OutputSink;
  abortSignal: AbortSignal;
  gatewayVersion: string;
  currentVersion: string;
  binaryPath: string;
  pauseSentinelPath: string;
  authFailedSentinelPath: string;
  bufferFullSentinelPath: string;
  sessionStoppedSentinelPath: string;
  updateAvailableSentinelPath?: string;
  loadConfig: () => Promise<GatewayConfig>;
  runDaemon: (deps: RunCommandDeps) => Promise<CommandResult>;
  createLogger: (options: LoggerFactoryOptions) => Promise<Logger>;
  env?: NodeJS.ProcessEnv;
}

export async function runDev(deps: DevCommandDeps): Promise<CommandResult> {
  const env = deps.env ?? process.env;
  env['PROXAI_NEST_URL'] = DEV_NEST_URL;

  const cfg = await deps.loadConfig();
  cfg.backend.ingestUrl = `${DEV_NEST_URL}/v1/raw_records`;
  cfg.backend.verifyKeyUrl = `${DEV_NEST_URL}/ingestion/verify-key`;
  cfg.backend.watermarksUrl = `${DEV_NEST_URL}/v1/watermarks`;
  cfg.backend.registerHostIdUrl = `${DEV_NEST_URL}/v1/host-ids/register`;

  const logger = await deps.createLogger({ pretty: true, level: cfg.logging.level });

  const runOpts: RunCommandDeps = {
    output: deps.output,
    config: cfg,
    pauseSentinelPath: deps.pauseSentinelPath,
    authFailedSentinelPath: deps.authFailedSentinelPath,
    bufferFullSentinelPath: deps.bufferFullSentinelPath,
    sessionStoppedSentinelPath: deps.sessionStoppedSentinelPath,
    abortSignal: deps.abortSignal,
    gatewayVersion: deps.gatewayVersion,
    currentVersion: deps.currentVersion,
    binaryPath: deps.binaryPath,
    installSource: cfg.account.installSource,
    devMode: true,
    logger,
  };
  if (deps.updateAvailableSentinelPath !== undefined) {
    runOpts.updateAvailableSentinelPath = deps.updateAvailableSentinelPath;
  }

  deps.output.info('proxai-gateway dev: forcing nest base url to ' + DEV_NEST_URL);
  const result = await deps.runDaemon(runOpts);
  return result.exitCode === EXIT_CODE.ok ? { exitCode: EXIT_CODE.ok } : result;
}
