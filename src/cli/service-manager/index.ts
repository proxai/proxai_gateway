import { createActor, type Actor } from 'xstate';
import { createLaunchctlManager } from 'cli/service-manager/launchctl.ts';
import { createSchtasksManager } from 'cli/service-manager/schtasks.ts';
import { createSystemctlManager } from 'cli/service-manager/systemctl.ts';
import { defaultSpawn } from 'cli/service-manager/run-command.ts';
import type { ServiceManager, ServiceManagerDeps } from 'cli/service-manager/types.ts';
import {
  serviceManagerMachine,
  type ServiceManagerMachine,
  type ServicePlatform,
} from 'services/state-machines/service-manager';

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

function platformToServicePlatform(platform: NodeJS.Platform): ServicePlatform {
  if (platform === 'darwin') return 'launchd';
  if (platform === 'linux') return 'systemd';
  if (platform === 'win32') return 'windows-task';
  throw new Error(`unsupported platform for service-manager: ${platform}`);
}

function buildInner(deps: ServiceManagerDeps): ServiceManager {
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

function wrapWithMachine(
  inner: ServiceManager,
  actor: Actor<ServiceManagerMachine>,
): ServiceManager {
  return {
    ensureRegistered: async () => {
      actor.send({ type: 'INSTALL' });
      try {
        await inner.ensureRegistered();
        actor.send({ type: 'INSTALL_COMPLETE' });
      } catch (err) {
        actor.send({ type: 'ERROR', message: err instanceof Error ? err.message : String(err) });
        throw err;
      }
    },
    start: async () => {
      actor.send({ type: 'START' });
      try {
        await inner.start();
        actor.send({ type: 'START_COMPLETE' });
      } catch (err) {
        actor.send({ type: 'ERROR', message: err instanceof Error ? err.message : String(err) });
        throw err;
      }
    },
    stop: async () => {
      actor.send({ type: 'STOP' });
      try {
        await inner.stop();
        actor.send({ type: 'STOP_COMPLETE' });
      } catch (err) {
        actor.send({ type: 'ERROR', message: err instanceof Error ? err.message : String(err) });
        throw err;
      }
    },
    restart: async () => {
      actor.send({ type: 'STOP' });
      try {
        await inner.restart();
        actor.send({ type: 'STOP_COMPLETE' });
        actor.send({ type: 'START' });
        actor.send({ type: 'START_COMPLETE' });
      } catch (err) {
        actor.send({ type: 'ERROR', message: err instanceof Error ? err.message : String(err) });
        throw err;
      }
    },
    unregister: async () => {
      actor.send({ type: 'UNINSTALL' });
      try {
        await inner.unregister();
        actor.send({ type: 'UNINSTALL_COMPLETE' });
      } catch (err) {
        actor.send({ type: 'ERROR', message: err instanceof Error ? err.message : String(err) });
        throw err;
      }
    },
    isRegistered: () => inner.isRegistered(),
    isRunning: () => inner.isRunning(),
    runtimeInfo: () => inner.runtimeInfo(),
  };
}

export function getServiceManager(deps: ServiceManagerDeps): ServiceManager {
  const inner = buildInner(deps);
  const actor = createActor(serviceManagerMachine, {
    input: { platform: platformToServicePlatform(deps.platform) },
  });
  actor.start();
  return wrapWithMachine(inner, actor);
}
