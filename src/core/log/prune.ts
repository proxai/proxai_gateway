import { stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import { setMode as defaultSetMode } from 'core/io/fs';
import {
  LOG_RETENTION_DAYS,
  LOG_TOTAL_SIZE_CAP_BYTES,
  STRUCTURED_LOG_BASENAME,
  STRUCTURED_LOG_EXTENSION,
} from 'core/log/log.constants.ts';
import type { PruneLogDirectoryOptions, PruneResult } from 'core/log/log.types.ts';

const FILE_MATCH_PATTERN = new RegExp(
  `^${STRUCTURED_LOG_BASENAME}\\.(\\d{4}-\\d{2}-\\d{2})\\.\\d+\\${STRUCTURED_LOG_EXTENSION}$`,
);

interface ScannedFile {
  name: string;
  path: string;
  date: string;
  size: number;
}

export async function pruneLogDirectory(
  dir: string,
  options: PruneLogDirectoryOptions = {},
): Promise<PruneResult> {
  const retentionDays = options.retentionDays ?? LOG_RETENTION_DAYS;
  const sizeCap = options.totalSizeCapBytes ?? LOG_TOTAL_SIZE_CAP_BYTES;
  const setMode = options.setMode ?? defaultSetMode;

  const files = await scanLogFiles(dir);
  files.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const deleted: string[] = [];

  while (files.length > retentionDays) {
    const oldest = files.shift();
    if (oldest === undefined) break;
    await unlink(oldest.path);
    deleted.push(oldest.path);
  }

  let totalSize = files.reduce((sum, f) => sum + f.size, 0);
  while (totalSize > sizeCap && files.length > 1) {
    const oldest = files.shift();
    if (oldest === undefined) break;
    await unlink(oldest.path);
    deleted.push(oldest.path);
    totalSize -= oldest.size;
  }

  await Promise.all(files.map((f) => setMode(f.path, 0o600).catch(() => {})));

  return {
    deletedFiles: deleted,
    retainedBytes: totalSize,
    retainedCount: files.length,
  };
}

async function scanLogFiles(dir: string): Promise<ScannedFile[]> {
  const { readdir } = await import('node:fs/promises');
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const found: ScannedFile[] = [];
  for (const name of entries) {
    const match = FILE_MATCH_PATTERN.exec(name);
    if (match === null) continue;
    const path = join(dir, name);
    let size: number;
    try {
      const s = await stat(path);
      size = s.size;
    } catch {
      continue;
    }
    found.push({ name, path, date: match[1] ?? '', size });
  }
  return found;
}
