import { join } from 'node:path';
import type { DevCommandDeps } from 'cli/commands/dev.ts';
import { consoleOutput } from 'cli/output.ts';
import { profileRootDir } from 'core/io/fs/profile.ts';

export function buildDevDeps(): DevCommandDeps {
  return {
    output: consoleOutput(),
    sentinelPath: join(profileRootDir(), 'DEV_MODE'),
  };
}
