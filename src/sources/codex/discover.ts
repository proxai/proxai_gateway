import type { Database } from 'bun:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { statFile } from 'core/io/fs';
import { openReadOnly, tableExists } from 'core/io/sqlite';
import { sha256Hex } from 'core/utils';
import { SUB_AGENT_CAPTURE_BY_SOURCE } from 'services/config/sub-agent-flags';
import {
  CODEX_HOME_SUBPATH,
  CODEX_ROLLOUT_GLOB,
  CODEX_STATE_GLOB,
  CODEX_THREAD_SPAWN_EDGES_TABLE,
  CODEX_THREADS_TABLE,
} from 'sources/codex/codex.constants.ts';
import type {
  DiscoveredCodexRolloutFile,
  DiscoveredCodexStateFile,
} from 'sources/codex/codex.types.ts';

export function defaultCodexHome(): string {
  return join(homedir(), CODEX_HOME_SUBPATH);
}

export interface DiscoverCodexOptions {
  minimumMtime?: Date | null;
  captureSubAgents?: boolean;
  readChildRolloutPaths?: (stateDbPath: string) => ReadonlySet<string>;
}

export async function discoverCodexRolloutFiles(
  baseDir: string = defaultCodexHome(),
  options: DiscoverCodexOptions = {},
): Promise<DiscoveredCodexRolloutFile[]> {
  const found: DiscoveredCodexRolloutFile[] = [];
  const minMtimeMs = options.minimumMtime?.getTime() ?? null;
  const captureSubAgents = options.captureSubAgents ?? SUB_AGENT_CAPTURE_BY_SOURCE.codex;
  const readChildren = options.readChildRolloutPaths ?? readChildRolloutPaths;

  const baseStat = await statFile(baseDir);
  if (!baseStat.exists) return found;

  const excludeRolloutPaths = await resolveExcludeRolloutPaths(
    baseDir,
    captureSubAgents,
    readChildren,
  );

  const glob = new Bun.Glob(CODEX_ROLLOUT_GLOB);
  for await (const relativePath of glob.scan({ cwd: baseDir, onlyFiles: true })) {
    const sourcePath = join(baseDir, relativePath);
    if (excludeRolloutPaths.has(sourcePath)) continue;
    const stat = await statFile(sourcePath);
    if (!stat.exists) continue;
    if (minMtimeMs !== null && stat.mtimeMs < minMtimeMs) continue;
    found.push({
      sourcePath,
      sourcePathHash: sha256Hex(sourcePath),
      inode: Number(stat.inode),
      sizeBytes: stat.size,
      lastModifiedMs: stat.mtimeMs,
    });
  }

  return found;
}

export async function resolveExcludeRolloutPaths(
  baseDir: string,
  captureSubAgents: boolean,
  readChildren: (stateDbPath: string) => ReadonlySet<string>,
): Promise<ReadonlySet<string>> {
  if (captureSubAgents) return new Set();
  const stateFile = await discoverCodexStateSqlite(baseDir);
  if (stateFile === null) return new Set();
  return readChildren(stateFile.sourcePath);
}

export async function discoverCodexStateSqlite(
  baseDir: string = defaultCodexHome(),
  options: DiscoverCodexOptions = {},
): Promise<DiscoveredCodexStateFile | null> {
  const baseStat = await statFile(baseDir);
  if (!baseStat.exists) return null;
  const minMtimeMs = options.minimumMtime?.getTime() ?? null;

  const glob = new Bun.Glob(CODEX_STATE_GLOB);
  const candidates: string[] = [];
  for await (const relativePath of glob.scan({ cwd: baseDir, onlyFiles: true })) {
    candidates.push(relativePath);
  }
  if (candidates.length === 0) return null;

  const highest = pickHighestNumberedState(candidates);
  if (highest === null) return null;

  const sourcePath = join(baseDir, highest);
  const stat = await statFile(sourcePath);
  if (!stat.exists) return null;
  if (minMtimeMs !== null && stat.mtimeMs < minMtimeMs) return null;

  return {
    sourcePath,
    sourcePathHash: sha256Hex(sourcePath),
    inode: Number(stat.inode),
    sizeBytes: stat.size,
    lastModifiedMs: stat.mtimeMs,
  };
}

export interface ReadChildRolloutPathsDeps {
  openDb?: (stateDbPath: string) => Database;
  hasTable?: (db: Database, name: string) => boolean;
}

export function readChildRolloutPaths(
  stateDbPath: string,
  deps: ReadChildRolloutPathsDeps = {},
): ReadonlySet<string> {
  const openDb = deps.openDb ?? openReadOnly;
  const hasTable = deps.hasTable ?? tableExists;
  try {
    const db = openDb(stateDbPath);
    try {
      return readChildRolloutPathsFromDb(db, hasTable);
    } finally {
      db.close();
    }
  } catch {
    return new Set();
  }
}

export function readChildRolloutPathsFromDb(
  db: Database,
  hasTable: (db: Database, name: string) => boolean = tableExists,
): ReadonlySet<string> {
  if (!hasTable(db, CODEX_THREAD_SPAWN_EDGES_TABLE) || !hasTable(db, CODEX_THREADS_TABLE)) {
    return new Set();
  }
  const sql = `SELECT t.rollout_path AS rollout_path
    FROM ${CODEX_THREAD_SPAWN_EDGES_TABLE} e
    JOIN ${CODEX_THREADS_TABLE} t ON e.child_thread_id = t.id`;
  const rows = db.query<{ rollout_path: unknown }, []>(sql).all();
  return buildChildRolloutSet(rows);
}

export function buildChildRolloutSet(
  rows: ReadonlyArray<{ rollout_path: unknown }>,
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const row of rows) {
    if (typeof row.rollout_path === 'string' && row.rollout_path.length > 0) {
      out.add(row.rollout_path);
    }
  }
  return out;
}

function pickHighestNumberedState(filenames: string[]): string | null {
  let bestName: string | null = null;
  let bestNumber = -Infinity;
  for (const name of filenames) {
    const match = /^state_(\d+)\.sqlite$/.exec(name);
    if (match === null) continue;
    const num = Number(match[1]);
    if (Number.isFinite(num) && num > bestNumber) {
      bestNumber = num;
      bestName = name;
    }
  }
  return bestName;
}
