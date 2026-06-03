import type { ProfileContext } from 'core/io/fs/profile.types.ts';
import { loadConfigFromFile } from 'services/config';

export interface ResolvedProfilePaths {
  readonly bufferDbPath: string;
  readonly logDir: string;
}

export async function resolveProfilePaths(
  profileCtx: ProfileContext,
): Promise<ResolvedProfilePaths> {
  try {
    const config = await loadConfigFromFile(profileCtx.configFilePath);
    return { bufferDbPath: config.capture.bufferPath, logDir: config.logging.logDir };
  } catch {
    return { bufferDbPath: profileCtx.bufferDbPath, logDir: profileCtx.logDir };
  }
}
