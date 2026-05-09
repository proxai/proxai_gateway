import { unlink } from 'node:fs/promises';

import { EXIT_CODE } from 'cli/cli.constants.ts';
import type { CommandResult, OutputSink } from 'cli/cli.types.ts';
import type { PromptSink } from 'cli/prompts.ts';
import type { ServiceManager } from 'cli/service-manager';
import type { DirectBinaryRemover } from 'services/uninstall';
import type { ShellPathCleaner } from 'services/uninstall';
import { isDirectBinary } from 'services/uninstall';
import type { PackageManagerSweep } from 'services/uninstall';
import { rmRecursive } from 'core/io/fs';

export interface UninstallCommandDeps {
  output: OutputSink;
  prompts: PromptSink;
  configPath: string;
  configDir: string;
  logDir: string;
  serviceUnitPath: string | null;
  serviceManager: ServiceManager;
  configExists: () => Promise<boolean>;
  sweep?: PackageManagerSweep;
  binaryRemover?: DirectBinaryRemover;
  pathCleaner?: ShellPathCleaner;
  installDir?: string;
  currentExecPath?: string;
}

export interface UninstallCommandOptions {
  reset?: boolean;
  yes?: boolean;
}

const SENTINEL_LIST =
  'PAUSED, AUTH_FAILED, BUFFER_FULL, SESSION_STOPPED, UPDATE_AVAILABLE, CONSENT_ACCEPTED';

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

function buildConfirmationMessage(deps: UninstallCommandDeps, reset: boolean): string {
  const execPath = deps.currentExecPath ?? process.execPath;
  const lines: string[] = [];
  lines.push('This will:');
  lines.push('  • stop and unregister the proxai-gateway daemon');
  if (deps.serviceUnitPath !== null) {
    lines.push(`  • remove the service unit at ${deps.serviceUnitPath}`);
  }
  lines.push('  • sweep package-manager installs (npm, pnpm, yarn, bun, brew)');
  if (isDirectBinary(execPath)) {
    lines.push(`  • remove the proxai-gateway binary at ${execPath}`);
  }
  lines.push('  • clean up the PATH entry from your shell rc / Windows User PATH');
  if (reset) {
    lines.push('');
    lines.push('--reset will additionally wipe local state:');
    lines.push(`  • ${deps.configDir}  (config, buffer DB, sentinels: ${SENTINEL_LIST})`);
    lines.push(`  • ${deps.logDir}  (logs)`);
    lines.push('');
    lines.push('Server-side state is preserved. Re-setup will resume cursors from server.');
    lines.push('Pending unuploaded batches will be lost; their bytes will be re-captured.');
  } else {
    lines.push('');
    lines.push('Local state (config, buffer, logs) is preserved.');
    lines.push('Pass --reset to also wipe local state.');
  }
  lines.push('');
  const phrase = reset ? 'uninstall --reset' : 'uninstall';
  lines.push(`Type '${phrase}' to confirm, or leave empty to abort`);
  return lines.join('\n');
}

async function runSweep(deps: UninstallCommandDeps, sweep: PackageManagerSweep): Promise<void> {
  let detections: Awaited<ReturnType<PackageManagerSweep['detectAll']>>;
  try {
    detections = await sweep.detectAll();
  } catch (err) {
    deps.output.warn(`package-manager detection failed: ${(err as Error).message ?? String(err)}`);
    detections = [];
  }

  for (const det of detections) {
    if (!det.available) {
      deps.output.info(`${det.name} not available — skipped`);
      continue;
    }
    if (!det.installed) {
      deps.output.info(`not installed via ${det.name}`);
      continue;
    }
    try {
      const res = await sweep.uninstall(det.name);
      if (res.ok) deps.output.info(res.message);
      else deps.output.warn(res.message);
    } catch (err) {
      deps.output.warn(`${det.name} uninstall threw: ${(err as Error).message ?? String(err)}`);
    }
  }

  try {
    const brew = await sweep.detectBrew();
    if (!brew.available) {
      deps.output.info('brew not available — skipped');
    } else if (!brew.installed) {
      deps.output.info('not installed via brew');
    } else {
      try {
        const res = await sweep.uninstallBrew();
        if (res.ok) deps.output.info(res.message);
        else deps.output.warn(res.message);
      } catch (err) {
        deps.output.warn(`brew uninstall threw: ${(err as Error).message ?? String(err)}`);
      }
    }
  } catch (err) {
    deps.output.warn(`brew detection failed: ${(err as Error).message ?? String(err)}`);
  }
}

async function runBinaryRemoval(deps: UninstallCommandDeps): Promise<void> {
  const execPath = deps.currentExecPath ?? process.execPath;
  if (!isDirectBinary(execPath)) {
    return;
  }
  if (deps.binaryRemover === undefined) {
    deps.output.info(`to remove the binary itself, run: rm ${execPath}`);
    return;
  }
  const removalOptions =
    deps.installDir !== undefined ? { installDir: deps.installDir } : undefined;
  const result = await deps.binaryRemover.remove(execPath, removalOptions);
  if (result.ok) {
    deps.output.info(result.message);
  } else {
    deps.output.warn(result.message);
  }
}

async function runPathCleanup(deps: UninstallCommandDeps): Promise<void> {
  const cleaner = deps.pathCleaner;
  if (cleaner === undefined || deps.installDir === undefined) return;
  let outcomes;
  try {
    outcomes = await cleaner.clean(deps.installDir);
  } catch (err) {
    deps.output.warn(`PATH cleanup failed: ${(err as Error).message ?? String(err)}`);
    return;
  }
  for (const o of outcomes) {
    if (o.cleaned) {
      deps.output.info(`${o.path}: ${o.reason}`);
    } else {
      deps.output.info(`${o.path}: ${o.reason}`);
    }
  }
}
