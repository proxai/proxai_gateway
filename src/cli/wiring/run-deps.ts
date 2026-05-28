import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { RunCommandDeps } from 'cli/commands/run';
import { consoleOutput } from 'cli/output.ts';
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
}

export function buildRunDeps(inputs: BuildRunDepsInputs): RunCommandDeps {
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
    devMode: existsSync(join(inputs.profileCtx.configDir, 'DEV_MODE')),
    exitProcess: inputs.exitProcess,
  };
  if (inputs.xstateInspect !== undefined) {
    deps.xstateInspect = inputs.xstateInspect;
  }
  return deps;
}
