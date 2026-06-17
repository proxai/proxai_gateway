import chalk from 'chalk';
import { EXIT_CODE } from 'cli/cli.constants.ts';
import type { CommandResult, OutputSink } from 'cli/cli.types.ts';
import type { ServiceManager } from 'cli/service-manager';
import {
  ensureServiceUnitExists,
  type EnsureServiceUnitDeps,
  type ServiceUnitRecreateConfig,
} from 'cli/service-unit/writer.ts';
import { ensureWatchdogUnitExists } from 'cli/service-unit/watchdog-writer.ts';
import type { WatchdogManager } from 'cli/watchdog-manager/types.ts';
import { clearSessionStoppedSentinel } from 'services/polling';

export interface StartCommandDeps {
  output: OutputSink;
  configExists: () => Promise<boolean>;
  serviceManager: ServiceManager;
  sessionStoppedSentinelPath: string;
  invokeSetup?: () => Promise<CommandResult>;
  serviceUnitRecreate?: ServiceUnitRecreateConfig;
  serviceUnitFileExists?: EnsureServiceUnitDeps['fileExists'];
  writeServiceUnitFn?: EnsureServiceUnitDeps['writer'];
  runAutoUpgrade?: () => Promise<void>;
  profileName?: string;
  platform?: NodeJS.Platform;
  watchdogUnitPaths?: {
    timerPath?: string;
    servicePath?: string;
    plistPath?: string;
    xmlPath?: string;
  };
  watchdogManager?: WatchdogManager;
}

export async function runStart(deps: StartCommandDeps): Promise<CommandResult> {
  const exists = await deps.configExists();
  if (!exists) {
    deps.output.warn('no configuration detected — entering first-time setup');
    if (deps.invokeSetup === undefined) {
      deps.output.error('setup is unavailable in this context');
      return { exitCode: EXIT_CODE.error };
    }
    return deps.invokeSetup();
  }
  try {
    await clearSessionStoppedSentinel(deps.sessionStoppedSentinelPath);
    if (deps.serviceUnitRecreate !== undefined) {
      const ensureDeps: EnsureServiceUnitDeps = {
        config: deps.serviceUnitRecreate,
        onRecreate: () => {
          deps.output.info('service unit missing — recreating from current binary');
        },
      };
      if (deps.serviceUnitFileExists !== undefined) {
        ensureDeps.fileExists = deps.serviceUnitFileExists;
      }
      if (deps.writeServiceUnitFn !== undefined) {
        ensureDeps.writer = deps.writeServiceUnitFn;
      }
      await ensureServiceUnitExists(ensureDeps);
    }
    if (deps.runAutoUpgrade !== undefined) {
      try {
        await deps.runAutoUpgrade();
      } catch {}
    }
    await deps.serviceManager.ensureRegistered();
    if (deps.watchdogUnitPaths !== undefined && deps.watchdogManager !== undefined) {
      await ensureWatchdogUnitExists({
        platform: deps.platform ?? process.platform,
        profileName: deps.profileName === 'dev' ? 'dev' : 'prod',
        programPath: deps.serviceUnitRecreate?.programPath ?? process.execPath,
        ...deps.watchdogUnitPaths,
      });
      await deps.watchdogManager.install();
    }
    await deps.serviceManager.start();
    deps.output.success('Daemon started successfully!');
    deps.output.info('');
    deps.output.info(`  ${chalk.green('●')} proxai-gateway - Active (Running)`);
    if (deps.profileName) {
      deps.output.info(`    ├─ Profile: ${chalk.cyan(deps.profileName)}`);
      deps.output.info(`    ├─ Status : ${chalk.green('running')}`);
    } else {
      deps.output.info(`    ├─ Status : ${chalk.green('running')}`);
    }
    deps.output.info(`    └─ Logs   : run ${chalk.cyan('proxai-gateway logs')} to view logs`);
    deps.output.info('');
    return { exitCode: EXIT_CODE.ok };
  } catch (err) {
    deps.output.error(formatError('start failed', err));
    return { exitCode: EXIT_CODE.error };
  }
}

function formatError(prefix: string, err: unknown): string {
  if (err instanceof Error) return `${prefix}: ${err.message}`;
  return `${prefix}: ${String(err)}`;
}
