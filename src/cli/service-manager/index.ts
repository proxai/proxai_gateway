import { createLaunchctlManager } from 'cli/service-manager/launchctl.ts';
import { createSchtasksManager } from 'cli/service-manager/schtasks.ts';
import { createSystemctlManager } from 'cli/service-manager/systemctl.ts';
import { defaultSpawn } from 'cli/service-manager/run-command.ts';
import type { ServiceManager, ServiceManagerDeps } from 'cli/service-manager/types.ts';

export type {
  CommandRunResult,
  ServiceManager,
  ServiceManagerDeps,
  ServiceRuntimeInfo,
  SpawnFn,
} from 'cli/service-manager/types.ts';
export { runCommand } from 'cli/service-manager/run-command.ts';
export { createLaunchctlManager, parseLaunchctlPrint } from 'cli/service-manager/launchctl.ts';
export { createSystemctlManager, parseSystemctlShow } from 'cli/service-manager/systemctl.ts';
export {
  createSchtasksManager,
  parseSchtasksQuery,
  parseTasklistPid,
} from 'cli/service-manager/schtasks.ts';

export function getServiceManager(deps: ServiceManagerDeps): ServiceManager {
  const spawn = deps.spawn ?? defaultSpawn();
  switch (deps.platform) {
    case 'darwin':
      return createLaunchctlManager(spawn, deps.unitPath);
    case 'linux':
      return createSystemctlManager(spawn);
    case 'win32':
      return createSchtasksManager(spawn, deps.unitPath);
    default:
      throw new Error(`unsupported platform for service-manager: ${deps.platform}`);
  }
}
