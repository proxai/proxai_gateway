import { unlink } from 'node:fs/promises';

import { EXIT_CODE } from 'cli/cli.constants.ts';
import type { CommandResult } from 'cli/cli.types.ts';
import { rmRecursive } from 'core/io/fs';

import { buildConfirmationMessage } from 'cli/commands/uninstall/confirmation-message.ts';
import { runBinaryRemoval } from 'cli/commands/uninstall/run-binary-removal.ts';
import { runPathCleanup } from 'cli/commands/uninstall/run-path-cleanup.ts';
import { runSweep } from 'cli/commands/uninstall/run-sweep.ts';
import type {
  UninstallCommandDeps,
  UninstallCommandOptions,
} from 'cli/commands/uninstall/uninstall.types.ts';

export type {
  UninstallCommandDeps,
  UninstallCommandOptions,
} from 'cli/commands/uninstall/uninstall.types.ts';

export async function runUninstall(
  deps: UninstallCommandDeps,
  options: UninstallCommandOptions = {},
): Promise<CommandResult> {
  const reset = options.reset === true;

  const cfgExists = await deps.configExists();
  const unitFileExists =
    deps.serviceUnitPath !== null ? await Bun.file(deps.serviceUnitPath).exists() : false;
  let registered = false;
  try {
    registered = await deps.serviceManager.isRegistered();
  } catch {
    registered = false;
  }

  if (!cfgExists && !unitFileExists && !registered) {
    deps.output.info('no installation found');
    return { exitCode: EXIT_CODE.ok };
  }

  if (options.yes !== true) {
    const message = buildConfirmationMessage(deps, reset);
    const phrase = reset ? 'uninstall --reset' : 'uninstall';
    const confirmed = await deps.prompts.confirmPhrase(message, phrase);
    if (!confirmed) {
      deps.output.info('aborted — nothing changed');
      return { exitCode: EXIT_CODE.alreadyInstalled };
    }
  }

  try {
    await deps.serviceManager.stop();
    deps.output.info('daemon stopped');
  } catch {
    deps.output.info('daemon was not running');
  }

  try {
    await deps.serviceManager.unregister();
    deps.output.info('service unregistered');
  } catch {
    deps.output.info('service was not registered');
  }

  if (deps.serviceUnitPath !== null) {
    try {
      await unlink(deps.serviceUnitPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'ENOENT') {
        deps.output.warn(
          `could not remove service unit file: ${(err as Error).message ?? String(err)}`,
        );
      }
    }
  }

  if (reset) {
    await rmRecursive(deps.configDir);
    await rmRecursive(deps.logDir);
    deps.output.success('local state wiped');
  }

  if (deps.sweep !== undefined) {
    await runSweep(deps, deps.sweep);
  }

  await runBinaryRemoval(deps);
  await runPathCleanup(deps);

  if (reset) {
    deps.output.success('uninstalled and reset');
  } else {
    deps.output.success('uninstalled');
  }
  return { exitCode: EXIT_CODE.ok };
}
