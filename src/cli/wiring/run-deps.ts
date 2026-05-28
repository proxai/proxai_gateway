import type { RunCommandDeps } from 'cli/commands/run';
import { consoleOutput } from 'cli/output.ts';
import { buildRunCoordinatedUpgradeDeps } from 'cli/wiring/upgrade-restore-deps.ts';
import type { ProfileContext } from 'core/io/fs/profile.types.ts';
import { GATEWAY_USER_AGENT, PACKAGE_VERSION } from 'core/utils';
import type { GatewayConfig } from 'services/config';

export interface BuildRunDepsInputs {
  config: GatewayConfig;
  abortSignal: AbortSignal;
  binaryPath: string;
  exitProcess: () => void;
  xstateInspect?: boolean | undefined;
  profileCtx: ProfileContext;
  platform?: NodeJS.Platform;
}

export function buildRunDeps(inputs: BuildRunDepsInputs): RunCommandDeps {
  const platform = inputs.platform ?? process.platform;
  const deps: RunCommandDeps = {
    profileCtx: inputs.profileCtx,
    output: consoleOutput(),
    config: inputs.config,
    authFailedSentinelPath: inputs.profileCtx.sentinels.authFailed,
    bufferFullSentinelPath: inputs.profileCtx.sentinels.bufferFull,
    sessionStoppedSentinelPath: inputs.profileCtx.sentinels.sessionStopped,
    updateAvailableSentinelPath: inputs.profileCtx.sentinels.updateAvailable,
    abortSignal: inputs.abortSignal,
    gatewayVersion: GATEWAY_USER_AGENT,
    currentVersion: PACKAGE_VERSION,
    binaryPath: inputs.binaryPath,
    installSource: inputs.config.account.installSource,
    devMode: inputs.profileCtx.isDev,
    exitProcess: inputs.exitProcess,
  };
  if (inputs.xstateInspect !== undefined) {
    deps.xstateInspect = inputs.xstateInspect;
  }
  const coordDeps = buildRunCoordinatedUpgradeDeps({
    binaryPath: inputs.binaryPath,
    platform,
    isDev: inputs.profileCtx.isDev,
  });
  if (coordDeps !== undefined) {
    deps.coordinatedUpgradeDeps = coordDeps;
  }
  return deps;
}
