import { unlink } from 'node:fs/promises';

import { writeAtomic } from 'core/io/fs/atomic.ts';
import type { SentinelHandle } from 'core/io/fs/fs.types.ts';
import { setMode } from 'core/io/fs/mode.ts';

export function sentinelHandle(path: string): SentinelHandle {
  return {
    exists: () => Bun.file(path).exists(),
    read: async () => {
      const f = Bun.file(path);
      if (!(await f.exists())) return '';
      return f.text();
    },
    write: async (body: string) => {
      await writeAtomic(path, body);
      
      
      await setMode(path, 0o600);
    },
    remove: async () => {
      await unlink(path).catch((err: unknown) => {
        if ((err as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') throw err;
      });
    },
  };
}
