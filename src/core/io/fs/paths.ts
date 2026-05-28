import { homedir } from 'node:os';
import { join } from 'node:path';

import { profileRootDir } from 'core/io/fs/profile.ts';

export function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

export function legacyRootDir(): string {
  return profileRootDir();
}
