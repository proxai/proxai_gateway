import { unlink } from 'node:fs/promises';

import { EXIT_CODE } from 'cli/cli.constants.ts';
import type { CommandResult, OutputSink } from 'cli/cli.types.ts';
import type { PromptSink } from 'cli/prompts.ts';
import type { ServiceManager } from 'cli/service-manager.ts';
import { rmRecursive } from 'core/io/fs';
import { loadConfigFromFile } from 'services/config';
import type { GatewayConfig, InstallSource } from 'services/config';

export interface UninstallCommandDeps {
  output: OutputSink;
  prompts: PromptSink;
  configPath: string;
  configDir: string;
  logDir: string;
  serviceUnitPath: string | null;
  serviceManager: ServiceManager;
  configExists: () => Promise<boolean>;
  loadConfig?: (path: string) => Promise<GatewayConfig>;
}

export interface UninstallCommandOptions {
  reset?: boolean;
  yes?: boolean;
}

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

  let installSource: InstallSource | null = null;
  if (cfgExists) {
    try {
      const loader = deps.loadConfig ?? loadConfigFromFile;
      const cfg = await loader(deps.configPath);
      installSource = cfg.account.installSource;
    } catch {
      installSource = null;
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
    if (options.yes !== true) {
      const message =
        `This will wipe ALL local gateway state:\n` +
        `  ${deps.configDir}                             (config, buffer, sentinels)\n` +
        `  ${deps.logDir}                                (logs)\n\n` +
        `Server-side state preserved. Re-setup will resume cursors from server.\n` +
        `Pending unuploaded batches will be lost; their bytes will be re-captured\n` +
        `on first poll after re-setup.\n\n` +
        `Continue?`;
      const confirmed = await deps.prompts.confirmReset(message);
      if (!confirmed) {
        deps.output.info('reset aborted — local state preserved');
        return { exitCode: EXIT_CODE.alreadyInstalled };
      }
    }

    await rmRecursive(deps.configDir);
    await rmRecursive(deps.logDir);
    deps.output.success('local state wiped');
  }

  deps.output.info(binaryRemovalHint(installSource));

  if (reset) {
    deps.output.success('uninstalled and reset');
  } else {
    deps.output.success('uninstalled');
  }
  return { exitCode: EXIT_CODE.ok };
}

function binaryRemovalHint(source: InstallSource | null): string {
  switch (source) {
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'bun':
      return `to remove the binary itself, run: ${source} uninstall -g @proxai/gateway`;
    case 'brew':
      return 'to remove the binary itself, run: brew uninstall proxai-gateway';
    case 'github_release':
      return 'to remove the binary itself, run: rm $(which proxai-gateway)';
    default:
      return 'remove the binary using your package manager (npm, brew, etc.) or rm $(which proxai-gateway)';
  }
}
