import type { BackfillCommandDeps, BackfillCommandOptions } from 'cli/commands/backfill.ts';
import { consoleOutput } from 'cli/output.ts';
import type { ServiceManager } from 'cli/service-manager';
import { authFailedSentinelPath, bufferFullSentinelPath, pausedSentinelPath } from 'core/io/fs';
import { GATEWAY_USER_AGENT } from 'core/utils';
import type { GatewayConfig } from 'services/config';

export interface BuildBackfillDepsInputs {
  config: GatewayConfig;
  serviceManager: ServiceManager | null;
}

export function buildBackfillDeps(inputs: BuildBackfillDepsInputs): BackfillCommandDeps {
  const deps: BackfillCommandDeps = {
    output: consoleOutput(),
    config: inputs.config,
    pauseSentinelPath: pausedSentinelPath(),
    authFailedSentinelPath: authFailedSentinelPath(),
    bufferFullSentinelPath: bufferFullSentinelPath(),
    gatewayVersion: GATEWAY_USER_AGENT,
  };
  const sm = inputs.serviceManager;
  if (sm !== null) {
    deps.isDaemonRunning = () => sm.isRunning();
  }
  return deps;
}

export function buildBackfillOptions(opts: { since: string }): BackfillCommandOptions {
  return { since: opts.since };
}
