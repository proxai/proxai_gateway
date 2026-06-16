import chalk from 'chalk';

import { writeServiceUnit } from 'cli/service-unit/writer.ts';
import { writeWatchdogServiceUnit } from 'cli/service-unit/watchdog-writer.ts';
import { GatewayError } from 'core/utils';
import { EXIT_CODE } from 'cli/cli.constants.ts';
import type { CommandResult } from 'cli/cli.types.ts';
import { clearSessionStoppedSentinel } from 'services/polling/session-stopped-sentinel.ts';

import type { SetupCommandDeps, SetupCommandOptions } from 'cli/commands/setup/setup.types.ts';

export async function writeServiceUnitIfNeeded(deps: SetupCommandDeps): Promise<void> {
  if (deps.serviceUnitPath === null) return;
  const writeInput: Parameters<typeof writeServiceUnit>[0] = {
    serviceUnitPath: deps.serviceUnitPath,
    programPath: deps.programPath,
    platform: deps.platform,
  };
  if (deps.windowsUserId !== undefined) writeInput.windowsUserId = deps.windowsUserId;
  await writeServiceUnit(writeInput);

  if (deps.watchdogUnitPaths !== undefined) {
    await writeWatchdogServiceUnit({
      platform: deps.platform,
      profileName: 'prod',
      programPath: deps.programPath,
      ...deps.watchdogUnitPaths,
    });
  }
}

export async function autoStartDaemon(
  deps: SetupCommandDeps,
  options: SetupCommandOptions,
): Promise<CommandResult> {
  if (options.noStart === true) {
    deps.output.info('');
    deps.output.info(
      `Run ${chalk.cyan('proxai-gateway start')} when you are ready to begin capturing.`,
    );
    return { exitCode: EXIT_CODE.ok };
  }

  if (deps.serviceManager === undefined) {
    deps.output.info('');
    deps.output.info(
      `Service manager unavailable in this environment; run ${chalk.cyan('proxai-gateway start')} manually to begin capturing.`,
    );
    return { exitCode: EXIT_CODE.ok };
  }

  try {
    if (deps.sessionStoppedSentinelPath !== undefined) {
      await clearSessionStoppedSentinel(deps.sessionStoppedSentinelPath);
    }
    await deps.serviceManager.ensureRegistered();
    await deps.serviceManager.start();
    if (deps.watchdogManager !== undefined) {
      await deps.watchdogManager.install();
    }
    deps.output.success('daemon started');
    deps.output.info('');
    deps.output.info(`  Logs:    ${chalk.cyan('proxai-gateway logs')}`);
    deps.output.info(`  Status:  ${chalk.cyan('proxai-gateway status')}`);
    deps.output.info(`  Stop:    ${chalk.cyan('proxai-gateway stop')}`);
  } catch (err) {
    deps.output.warn(formatError('daemon auto-start failed', err));
    deps.output.info(
      `Setup completed; run ${chalk.cyan('proxai-gateway start')} manually to begin capturing.`,
    );
  }

  return { exitCode: EXIT_CODE.ok };
}

function formatError(prefix: string, err: unknown): string {
  if (err instanceof GatewayError) return `${prefix}: ${err.message}`;
  if (err instanceof Error) return `${prefix}: ${err.message}`;
  return `${prefix}: ${String(err)}`;
}
