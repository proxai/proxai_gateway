import { isDirectBinary } from 'services/uninstall';

import type { UninstallCommandDeps } from 'cli/commands/uninstall/uninstall.types.ts';

export async function runBinaryRemoval(deps: UninstallCommandDeps): Promise<void> {
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
