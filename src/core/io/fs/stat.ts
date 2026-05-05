import { stat as nodeStat } from 'node:fs/promises';

import type { StatResult } from 'core/io/fs/fs.types.ts';

export async function statFile(path: string): Promise<StatResult> {
  try {
    const s = await nodeStat(path, { bigint: true });
    return {
      exists: true,
      size: Number(s.size),
      mtimeMs: Number(s.mtimeMs),
      mtimeNs: s.mtimeNs,
      inode: s.ino,
    };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      return { exists: false };
    }
    throw err;
  }
}
