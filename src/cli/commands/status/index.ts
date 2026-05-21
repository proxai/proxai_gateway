import chalk from 'chalk';
import { existsSync } from 'node:fs';
import { devModeSentinelPath } from 'core/io/fs';

import { EXIT_CODE } from 'cli/cli.constants.ts';
import type { CommandResult } from 'cli/cli.types.ts';
import { formatBytes } from 'core/utils';

import { statusDot } from 'cli/commands/status/decorators.ts';
import { buildEmptyStatusJson, buildStatusJson } from 'cli/commands/status/build-json.ts';
import { gatherStatusSnapshot } from 'cli/commands/status/gather-snapshot.ts';
import { renderHumanStatus } from 'cli/commands/status/render-human.ts';
import type { StatusCommandDeps, StatusCommandOptions } from 'cli/commands/status/status.types.ts';

export type {
  StatusCommandDeps,
  StatusCommandOptions,
  StatusJsonOutput,
  StatusSnapshot,
} from 'cli/commands/status/status.types.ts';
export { formatBytes };
export { readShippedBySource } from 'cli/commands/status/gather-snapshot.ts';

export async function runStatus(
  deps: StatusCommandDeps,
  options: StatusCommandOptions = {},
): Promise<CommandResult> {
  const exists = await deps.configExists();
  if (!exists) {
    const isDevMode = existsSync(deps.devModeSentinelPath ?? devModeSentinelPath());
    if (options.json === true) {
      const emptyJson = buildEmptyStatusJson();
      emptyJson.isDevMode = isDevMode;
      deps.output.info(JSON.stringify(emptyJson));
      return { exitCode: EXIT_CODE.notInstalled };
    }
    deps.output.info(
      `Status: ${statusDot('inactive')} not configured${isDevMode ? chalk.cyan(' (dev mode)') : ''}`,
    );
    deps.output.info('');
    deps.output.info(`Run ${chalk.cyan('proxai-gateway setup')} to begin.`);
    return { exitCode: EXIT_CODE.notInstalled };
  }

  if (deps.buffer === undefined) {
    deps.output.error('buffer database is unavailable');
    return { exitCode: EXIT_CODE.error };
  }

  const snapshot = await gatherStatusSnapshot(deps, deps.buffer);

  if (options.json === true) {
    deps.output.info(JSON.stringify(buildStatusJson(snapshot)));
    return { exitCode: EXIT_CODE.ok };
  }

  renderHumanStatus(deps, snapshot);
  return { exitCode: EXIT_CODE.ok };
}
