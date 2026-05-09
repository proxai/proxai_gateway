import type { RunCommandDeps } from 'cli/commands/run.ts';
import { consoleOutput } from 'cli/output.ts';
import {
  authFailedSentinelPath,
  bufferFullSentinelPath,
  pausedSentinelPath,
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
}

export function buildRunDeps(inputs: BuildRunDepsInputs): RunCommandDeps {
  return {
    output: consoleOutput(),
    config: inputs.config,
    pauseSentinelPath: pausedSentinelPath(),
    authFailedSentinelPath: authFailedSentinelPath(),
    bufferFullSentinelPath: bufferFullSentinelPath(),
    sessionStoppedSentinelPath: sessionStoppedSentinelPath(),
    updateAvailableSentinelPath: updateAvailableSentinelPath(),
    abortSignal: inputs.abortSignal,
    gatewayVersion: GATEWAY_USER_AGENT,
    currentVersion: PACKAGE_VERSION,
    binaryPath: inputs.binaryPath,
    installSource: inputs.config.account.installSource,
    devMode: false,
    exitProcess: inputs.exitProcess,
  };
}
