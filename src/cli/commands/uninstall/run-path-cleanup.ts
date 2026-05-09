import type { UninstallCommandDeps } from 'cli/commands/uninstall/uninstall.types.ts';

export async function runPathCleanup(deps: UninstallCommandDeps): Promise<void> {
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
    deps.output.info(`${o.path}: ${o.reason}`);
  }
}
