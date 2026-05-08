import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openReadOnly } from 'core/io/sqlite/open.ts';
import type { Snapshot } from 'core/io/sqlite/sqlite.types.ts';

export async function snapshotSqlite(sourcePath: string): Promise<Snapshot> {
  const tmpPath = join(tmpdir(), `proxai-snap-${randomUUID()}.sqlite`);
  const db = openReadOnly(sourcePath, { immutable: true });
  try {
    db.run(`VACUUM INTO '${escapeSqliteString(tmpPath)}'`);
  } finally {
    db.close();
  }
  return {
    path: tmpPath,
    cleanup: async () => {
      await unlink(tmpPath).catch(() => undefined);
    },
  };
}

function escapeSqliteString(value: string): string {
  return value.replace(/'/g, "''");
}
