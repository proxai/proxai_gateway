import chalk from 'chalk';
import { unlink } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { createActor } from 'xstate';

import { EXIT_CODE } from 'cli/cli.constants.ts';
import type { CommandResult, OutputSink } from 'cli/cli.types.ts';
import { readDevModeSentinel, rmRecursive } from 'core/io/fs';
import { readBootId } from 'core/system/boot-id.ts';
import { uninstallMachine } from 'services/state-machines/uninstall';

import { buildConfirmationMessage } from 'cli/commands/uninstall/confirmation-message.ts';
import { runBinaryRemoval } from 'cli/commands/uninstall/run-binary-removal.ts';
import { runPathCleanup } from 'cli/commands/uninstall/run-path-cleanup.ts';
import { runSweep } from 'cli/commands/uninstall/run-sweep.ts';
import type {
  UninstallCommandDeps,
  UninstallCommandOptions,
} from 'cli/commands/uninstall/uninstall.types.ts';

const ROOT_FILES_TO_REMOVE = [
  '.migrated-flat-to-nested',
  '.upgrade-restore-state',
  '.upgrade.lock',
  '.migration.lock',
  'DEV_MODE',
  'config.toml',
] as const;

const FLAT_LAYOUT_BUFFER_FILES = ['buffer.db', 'buffer.db-wal', 'buffer.db-shm'] as const;

export type {
  UninstallCommandDeps,
  UninstallCommandOptions,
} from 'cli/commands/uninstall/uninstall.types.ts';

const noop = (): void => {};
const SILENT_OUTPUT: OutputSink = { info: noop, warn: noop, error: noop, success: noop };

async function removeUnitFile(deps: UninstallCommandDeps, unitPath: string | null): Promise<void> {
  if (unitPath === null) return;
  try {
    await unlink(unitPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== 'ENOENT') {
      deps.output.warn(
        `could not remove service unit file: ${(err as Error).message ?? String(err)}`,
      );
    }
  }
}

export async function runUninstall(
  deps: UninstallCommandDeps,
  options: UninstallCommandOptions = {},
): Promise<CommandResult> {
  const reset = options.reset === true;
  const machine = createActor(uninstallMachine, { input: { resetMode: reset } });
  machine.start();

  const isDevMode =
    deps.isDevMode ??
    (await readDevModeSentinel(
      join(deps.profileRootDir, 'DEV_MODE'),
      deps.readBootId ?? readBootId,
    ));

  const uninstallOutput: OutputSink = isDevMode ? deps.output : SILENT_OUTPUT;

  const uninstallDeps: UninstallCommandDeps = {
    ...deps,
    output: uninstallOutput,
  };

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
    if (isDevMode) {
      deps.output.info('no installation found');
    } else {
      if (reset) {
        deps.output.success('uninstalled and reset');
      } else {
        deps.output.success('uninstalled');
      }
    }
    machine.stop();
    return { exitCode: EXIT_CODE.ok };
  }

  if (reset && options.yes !== true) {
    deps.output.info(buildConfirmationMessage());
    const phrase = 'uninstall';
    const confirmed = await deps.prompts.confirmPhrase(
      `Type ${chalk.cyan('uninstall')} to confirm this reset, or press Enter to abort.`,
      phrase,
    );
    if (!confirmed) {
      uninstallDeps.output.info('aborted — nothing changed');
      machine.stop();
      return { exitCode: EXIT_CODE.alreadyInstalled };
    }
  }

  machine.send({ type: 'BEGIN' });

  if (deps.devServiceManager !== null) {
    try {
      await deps.devServiceManager.stop();
    } catch {}

    try {
      await deps.devServiceManager.unregister();
    } catch {}

    await removeUnitFile(uninstallDeps, deps.devServiceUnitPath);
  }

  try {
    await deps.serviceManager.stop();
    uninstallDeps.output.info('daemon stopped');
  } catch {
    uninstallDeps.output.info('daemon was not running');
  }

  try {
    await deps.serviceManager.unregister();
    uninstallDeps.output.info('service unregistered');
  } catch {
    uninstallDeps.output.info('service was not registered');
  }

  await removeUnitFile(uninstallDeps, deps.serviceUnitPath);
  machine.send({ type: 'SERVICE_STOPPED' });

  let pathsSwept = 0;
  if (reset) {
    await rmRecursive(deps.configDir);
    await rmRecursive(deps.logDir);
    await rmRecursive(deps.devConfigDir);
    await rmRecursive(deps.devLogDir);
    await Promise.all(
      FLAT_LAYOUT_BUFFER_FILES.map((file) => rmRecursive(join(deps.profileRootDir, file))),
    );
    for (const file of ROOT_FILES_TO_REMOVE) {
      rmSync(join(deps.profileRootDir, file), { force: true });
    }
    pathsSwept += 4;
    uninstallDeps.output.success('local state wiped');
  }

  if (deps.sweep !== undefined) {
    await runSweep(uninstallDeps, deps.sweep);
    pathsSwept += 1;
  }
  machine.send({ type: 'PATHS_SWEPT', count: pathsSwept });

  await runBinaryRemoval(uninstallDeps);
  machine.send({ type: 'BUFFER_REMOVED' });
  await runPathCleanup(uninstallDeps);
  machine.send({ type: 'SENTINELS_REMOVED', count: 0 });

  if (reset) {
    deps.output.success('uninstalled and reset');
  } else {
    deps.output.success('uninstalled');
  }
  machine.stop();
  return { exitCode: EXIT_CODE.ok };
}
