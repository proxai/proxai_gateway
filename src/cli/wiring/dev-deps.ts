import type { DevCommandDeps } from 'cli/commands/dev.ts';
import { consoleOutput } from 'cli/output.ts';
import { devModeSentinelPath } from 'core/io/fs';

export function buildDevDeps(): DevCommandDeps {
  return {
    output: consoleOutput(),
    sentinelPath: devModeSentinelPath(),
  };
}
