import type { DevCommandDeps } from 'cli/commands/dev.ts';
import { runDaemon } from 'cli/commands/run';
import { consoleOutput } from 'cli/output.ts';
import { createLogger } from 'core/log';
import {
  authFailedSentinelPath,
  bufferFullSentinelPath,
  pausedSentinelPath,
  sessionStoppedSentinelPath,
  updateAvailableSentinelPath,
} from 'core/io/fs';
import { GATEWAY_USER_AGENT, PACKAGE_VERSION } from 'core/utils';
import { loadConfigFromFile } from 'services/config';

export interface BuildDevDepsInputs {
  abortSignal: AbortSignal;
  binaryPath: string;
}

export function buildDevDeps(inputs: BuildDevDepsInputs): DevCommandDeps {
  return {
    output: consoleOutput(),
    abortSignal: inputs.abortSignal,
    gatewayVersion: GATEWAY_USER_AGENT,
    currentVersion: PACKAGE_VERSION,
    binaryPath: inputs.binaryPath,
    pauseSentinelPath: pausedSentinelPath(),
    authFailedSentinelPath: authFailedSentinelPath(),
    bufferFullSentinelPath: bufferFullSentinelPath(),
    sessionStoppedSentinelPath: sessionStoppedSentinelPath(),
    updateAvailableSentinelPath: updateAvailableSentinelPath(),
    loadConfig: () => loadConfigFromFile(),
    runDaemon,
    createLogger,
  };
}
