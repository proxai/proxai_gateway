// src/services/exclusion/cursor-folder.ts
import { fileURLToPath } from 'node:url';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Convert a `file://` URI to an absolute filesystem path, or null if it is not a file URI. */
export function fileUriToPath(uri: string): string | null {
  if (typeof uri !== 'string' || !uri.startsWith('file://')) return null;
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

/** Parse a Cursor `workspace.json` text and return its `folder` as a path, or null. */
export function parseWorkspaceFolder(jsonText: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (typeof parsed.folder !== 'string') return null;
  return fileUriToPath(parsed.folder);
}

/**
 * Parse the global DB's `composer.composerHeaders` ItemTable value into a
 * `Map<composerId, folderPath|null>`. `null` means the composer has no
 * resolvable folder (empty-window / ephemeral) → fail-open (never excluded).
 */
export function parseComposerHeadersFolders(jsonText: string): Map<string, string | null> {
  const map = new Map<string, string | null>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return map;
  }
  if (!isRecord(parsed)) return map;
  const all = parsed.allComposers;
  if (!Array.isArray(all)) return map;
  for (const entry of all) {
    if (!isRecord(entry)) continue;
    const composerId = entry.composerId;
    if (typeof composerId !== 'string') continue;
    const wsId = entry.workspaceIdentifier;
    const uri = isRecord(wsId) ? wsId.uri : undefined;
    const external = isRecord(uri) ? uri.external : undefined;
    map.set(composerId, typeof external === 'string' ? fileUriToPath(external) : null);
  }
  return map;
}
