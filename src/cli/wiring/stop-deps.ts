import type { StopCommandDeps } from 'cli/commands/stop.ts';
import { consoleOutput } from 'cli/output.ts';
import type { ServiceManager } from 'cli/service-manager.ts';
import { sessionStoppedSentinelPath } from 'core/io/fs';

export function buildStopDeps(serviceManager: ServiceManager): StopCommandDeps {
  return {
    output: consoleOutput(),
    serviceManager,
    sessionStoppedSentinelPath: sessionStoppedSentinelPath(),
  };
}
