import { existsSync } from 'node:fs';
import { chmod, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import { ORG_NAME } from './fs.constants.ts';
import { profileRootDir, profileLogDirRoot } from './profile.ts';

export async function ensureDir(path: string, mode = 0o700): Promise<void> {
  if (process.platform !== 'win32') {
    const rootDir = profileRootDir();
    if (path.startsWith(rootDir)) {
      await mkdir(rootDir, { recursive: true });
      await chmod(rootDir, 0o700);
    }
    const logDir = profileLogDirRoot();
    if (path.startsWith(logDir)) {
      await mkdir(logDir, { recursive: true });
      await chmod(logDir, 0o700);
    }
  }

  await mkdir(path, { recursive: true, mode });
  if (process.platform !== 'win32') {
    await chmod(path, mode);
  }
}

export async function setMode(path: string, mode: number): Promise<void> {
  if (process.platform === 'win32') return;
  await chmod(path, mode);
}

export async function ensureSecureBaseDirs(paths: string | string[]): Promise<void> {
  const targets = Array.isArray(paths) ? paths : [paths];

  await Promise.all(targets.map((target) => ensureDir(target, 0o700)));

  if (process.platform === 'win32') {
    return;
  }

  const dirsToChmod = new Set<string>();
  for (const target of targets) {
    let current = target;
    while (true) {
      const parent = dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;

      const segments = current.split(/[/\\]/);
      if (segments.some((s) => s.toLowerCase() === ORG_NAME.toLowerCase())) {
        if (existsSync(current)) {
          dirsToChmod.add(current);
        }
      } else {
        break;
      }
    }
  }

  await Promise.all(Array.from(dirsToChmod).map((dir) => chmod(dir, 0o700)));
}
