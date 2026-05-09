import type { PackageManagerSweep } from 'services/uninstall';

import type { UninstallCommandDeps } from 'cli/commands/uninstall/uninstall.types.ts';

export async function runSweep(
  deps: UninstallCommandDeps,
  sweep: PackageManagerSweep,
): Promise<void> {
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
