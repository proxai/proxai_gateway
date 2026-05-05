import { ensureDir } from 'core/io/fs';
import { dirname } from 'node:path';

import { EXIT_CODE } from 'cli/cli.constants.ts';
import type { CommandResult, OutputSink } from 'cli/cli.types.ts';
import { openBufferDb } from 'services/buffer';
import type { GatewayConfig } from 'services/config';
import { HttpClient } from 'services/http';
import { buildDefaultSources, runPollLoop } from 'services/polling';
import type { PollCycleResult, RegisteredSource } from 'services/polling';

export interface RunCommandDeps {
  output: OutputSink;
  config: GatewayConfig;
  pauseSentinelPath: string;
  abortSignal: AbortSignal;
  gatewayVersion: string;
  sources?: readonly RegisteredSource[];
  onCycleComplete?: (result: PollCycleResult) => void;
}

export async function runDaemon(deps: RunCommandDeps): Promise<CommandResult> {
  await ensureDir(dirname(deps.config.capture.bufferPath));
  const buffer = openBufferDb(deps.config.capture.bufferPath);

  const http = new HttpClient({
    apiKey: deps.config.account.apiKey,
    hostId: deps.config.account.hostId,
    endpoints: {
      ingest: deps.config.backend.ingestUrl,
      authValidate: deps.config.backend.authValidateUrl,
      health: deps.config.backend.healthUrl,
      latestVersion: deps.config.backend.latestVersionUrl,
      allowedHosts: deps.config.backend.allowedHostsUrl,
    },
    gatewayVersion: deps.gatewayVersion,
  });

  try {
    deps.output.info(
      `starting poll loop (interval: ${deps.config.capture.pollIntervalSec.toString()}s)`,
    );
    const loopOptions: {
      intervalMs: number;
      abortSignal: AbortSignal;
      onCycleComplete?: (result: PollCycleResult) => void;
    } = {
      intervalMs: deps.config.capture.pollIntervalSec * 1000,
      abortSignal: deps.abortSignal,
    };
    if (deps.onCycleComplete !== undefined) loopOptions.onCycleComplete = deps.onCycleComplete;
    await runPollLoop(
      {
        buffer,
        http,
        hostId: deps.config.account.hostId,
        gatewayVersion: deps.gatewayVersion,
        sources: deps.sources ?? buildDefaultSources({}),
        pauseSentinelPath: deps.pauseSentinelPath,
      },
      loopOptions,
    );
  } finally {
    buffer.close();
  }

  deps.output.info('poll loop exited');
  return { exitCode: EXIT_CODE.ok };
}
