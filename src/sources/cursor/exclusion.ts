// src/sources/cursor/exclusion.ts
import type { Database } from 'bun:sqlite';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

import { tableExists } from 'core/io/sqlite';

import {
  decodeConversationStateHashes,
  isFolderUnderPrefixes,
  lexicalFolderKey,
  normalizeExcludedPrefixes,
  parseComposerHeadersFolders,
  parseWorkspaceFolder,
} from 'services/exclusion';
import {
  CURSOR_DISK_KV_TABLE,
  CURSOR_KEY_PREFIX_COMPOSER,
} from 'sources/cursor/cursor.constants.ts';

const COMPOSER_HEADERS_ITEM_KEY = 'composer.composerHeaders';

export interface CursorGlobalExclusionPlan {
  /** composerIds whose folder is excluded — their composerData/bubble rows are dropped. */
  excludedComposerIds: Set<string>;
  /** agentKv blob hashes referenced ONLY by excluded composers — dropped. */
  blobsToDrop: Set<string>;
}

/** The global DB mixes all workspaces; per-workspace DBs map 1:1 to a folder. */
export function isCursorGlobalDb(sourcePath: string): boolean {
  return sourcePath.includes('/globalStorage/');
}

/** Resolve a per-workspace state.vscdb's folder via its sibling workspace.json. Null = fail-open. */
export function resolveCursorWorkspaceFolder(stateVscdbPath: string): string | null {
  const workspaceJson = join(dirname(stateVscdbPath), 'workspace.json');
  let text: string;
  try {
    text = readFileSync(workspaceJson, 'utf8');
  } catch {
    return null;
  }
  return parseWorkspaceFolder(text);
}

interface ItemValueRow {
  value: string;
}
interface ComposerKvRow {
  key: string;
  value: string;
}

/**
 * Build the per-composer exclusion plan for the global DB. Reads the
 * `composer.composerHeaders` ItemTable key (composer → folder) and every
 * `composerData:*` row (composer → ordered blob hashes via conversationState),
 * independent of the rowid watermark. A blob is dropped only if referenced
 * exclusively by excluded composers (content-addressed blobs can be shared).
 */
export function buildCursorGlobalExclusionPlan(
  db: Database,
  excludedProjects: readonly string[],
): CursorGlobalExclusionPlan {
  const excludedComposerIds = new Set<string>();
  const blobsToDrop = new Set<string>();
  const excludedPrefixes = normalizeExcludedPrefixes(excludedProjects);
  if (excludedPrefixes.length === 0) {
    return { excludedComposerIds, blobsToDrop };
  }

  // composerId -> folder (authoritative folder source). Fail open if ItemTable is absent
  // (atypical/partial/corrupt profile) — never throw; every composer just keeps shipping.
  const headerRow = tableExists(db, 'ItemTable')
    ? db
        .query<
          ItemValueRow,
          [string]
        >(`SELECT CAST(value AS TEXT) AS value FROM ItemTable WHERE key = ?`)
        .get(COMPOSER_HEADERS_ITEM_KEY)
    : null;
  const folderByComposer = headerRow
    ? parseComposerHeadersFolders(headerRow.value)
    : new Map<string, string | null>();

  for (const [composerId, folder] of folderByComposer) {
    if (folder !== null && isFolderUnderPrefixes(folder, excludedPrefixes)) {
      excludedComposerIds.add(composerId);
    }
  }

  // composerId -> ordered blob hashes (from conversationState), classified into
  // excluded vs kept; blobsToDrop = excluded \ kept.
  const composerRows = db
    .query<
      ComposerKvRow,
      [string]
    >(`SELECT key, CAST(value AS TEXT) AS value FROM ${CURSOR_DISK_KV_TABLE} WHERE key LIKE ?`)
    .all(`${CURSOR_KEY_PREFIX_COMPOSER}%`);

  const keepHashes = new Set<string>();
  const excludedHashes = new Set<string>();
  for (const row of composerRows) {
    const composerId = row.key.slice(CURSOR_KEY_PREFIX_COMPOSER.length);
    let hashes: string[] = [];
    try {
      const parsed: unknown = JSON.parse(row.value);
      const cs =
        parsed !== null && typeof parsed === 'object'
          ? (parsed as { conversationState?: unknown }).conversationState
          : undefined;
      if (typeof cs === 'string') hashes = decodeConversationStateHashes(cs);
    } catch {
      hashes = [];
    }
    const target = excludedComposerIds.has(composerId) ? excludedHashes : keepHashes;
    for (const h of hashes) target.add(h);
  }

  for (const h of excludedHashes) {
    if (!keepHashes.has(h)) blobsToDrop.add(h);
  }

  return { excludedComposerIds, blobsToDrop };
}

/** Canonical, sorted, de-duplicated exclusion set used for the backfill fingerprint. */
export function normalizeExclusionSet(excludedProjects: readonly string[]): string[] {
  const set = new Set<string>();
  for (const raw of excludedProjects) {
    if (raw.trim().length === 0) continue;
    // Lexical (no realpathSync) so the fingerprint depends only on the file contents and does
    // not drift if an excluded folder is created/deleted/relinked between cycles.
    set.add(lexicalFolderKey(raw));
  }
  return [...set].toSorted();
}

/** True if any entry present in the stored set is absent from the current set (a folder was un-excluded). */
export function exclusionEntriesRemoved(
  storedJson: string | null,
  current: readonly string[],
): boolean {
  if (storedJson === null) return false;
  let stored: unknown;
  try {
    stored = JSON.parse(storedJson);
  } catch {
    return false;
  }
  if (!Array.isArray(stored)) return false;
  const cur = new Set(current);
  return stored.some((e) => typeof e === 'string' && !cur.has(e));
}
