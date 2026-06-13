import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Database } from 'bun:sqlite';

import { openReadOnly, type OpenReadOnlyOptions } from 'core/io/sqlite/open.ts';
import type { Snapshot } from 'core/io/sqlite/sqlite.types.ts';

export type SnapshotOpenImpl = (path: string, options?: OpenReadOnlyOptions) => Database;

export interface SnapshotSqliteOptions {
  openImpl?: SnapshotOpenImpl;
}

export async function snapshotSqlite(
  sourcePath: string,
  options: SnapshotSqliteOptions = {},
): Promise<Snapshot> {
  const open = options.openImpl ?? openReadOnly;
  const tmpPath = join(tmpdir(), `proxai-snap-${randomUUID()}.sqlite`);
  try {
    vacuumInto(open(sourcePath), tmpPath);
  } catch (firstErr) {
    await unlink(tmpPath).catch(() => undefined);
    try {
      vacuumInto(open(sourcePath, { immutable: true }), tmpPath);
    } catch {
      throw firstErr;
    }
  }
  return {
    path: tmpPath,
    cleanup: async () => {
      await unlink(tmpPath).catch(() => undefined);
    },
  };
}

function vacuumInto(db: Database, tmpPath: string): void {
  try {
    db.run(`VACUUM INTO '${escapeSqliteString(tmpPath)}'`);
  } finally {
    db.close();
  }
}

function escapeSqliteString(value: string): string {
  return value.replace(/'/g, "''");
}
