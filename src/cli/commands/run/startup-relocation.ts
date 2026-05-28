import { profileRootDir as defaultProfileRootDir } from 'core/io/fs/profile.ts';
import { relocateFlatToNested } from 'core/io/fs/migrate-flat-to-nested.ts';

export interface DaemonStartupRelocationDeps {
  readonly profileRootDir: () => string;
}

export async function runDaemonStartupRelocation(
  deps: DaemonStartupRelocationDeps = { profileRootDir: defaultProfileRootDir },
): Promise<void> {
  await relocateFlatToNested(deps.profileRootDir());
}
