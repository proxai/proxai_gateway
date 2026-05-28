import { existsSync } from 'node:fs';

import type { RunCommandDeps } from 'cli/commands/run';
import { consoleOutput } from 'cli/output.ts';
import {
  authFailedSentinelPath,
  bufferFullSentinelPath,
  devModeSentinelPath,
  sessionStoppedSentinelPath,
  updateAvailableSentinelPath,
} from 'core/io/fs';
import { GATEWAY_USER_AGENT, PACKAGE_VERSION } from 'core/utils';
import type { GatewayConfig } from 'services/config';

export interface BuildRunDepsInputs {
  config: GatewayConfig;
  abortSignal: AbortSignal;
  binaryPath: string;
  exitProcess: () => void;
  xstateInspect?: boolean | undefined;
}

export function buildRunDeps(inputs: BuildRunDepsInputs): RunCommandDeps {
  const deps: RunCommandDeps = {
    output: consoleOutput(),
    config: inputs.config,
    authFailedSentinelPath: authFailedSentinelPath(),
    bufferFullSentinelPath: bufferFullSentinelPath(),
    sessionStoppedSentinelPath: sessionStoppedSentinelPath(),
    updateAvailableSentinelPath: updateAvailableSentinelPath(),
    abortSignal: inputs.abortSignal,
    gatewayVersion: GATEWAY_USER_AGENT,
    currentVersion: PACKAGE_VERSION,
    binaryPath: inputs.binaryPath,
    installSource: inputs.config.account.installSource,
    devMode: existsSync(devModeSentinelPath()),
    exitProcess: inputs.exitProcess,
  };
  if (inputs.xstateInspect !== undefined) {
    deps.xstateInspect = inputs.xstateInspect;
  }
  return deps;
}
