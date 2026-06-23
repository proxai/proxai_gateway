// src/services/exclusion/cursor-folder.ts

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Convert a `file://` URI to an absolute filesystem path, or null if it is not a
 * local file URI. OS-AGNOSTIC on purpose: the captured URI reflects whichever host
 * produced it, but the daemon ships to Windows/Linux/macOS, so we parse the URI
 * ourselves rather than via node:url's host-native `fileURLToPath` — the latter
 * throws `ERR_INVALID_FILE_URL_PATH` on a driveless POSIX URI (`file:///Users/…`)
 * when it runs on Windows, which silently dropped the folder identity. The WHATWG
 * `URL` pathname is always `/`-separated and percent-encoded: we decode it and
 * strip the leading slash off a Windows drive URI (`file:///C:/x` → `C:/x`).
 * Downstream comparison (`normalizeFolderPath`) canonicalizes separators, so a
 * `/`-form result matches on every platform.
 */
export function fileUriToPath(uri: string): string | null {
  if (typeof uri !== 'string' || !uri.startsWith('file://')) return null;
  try {
    const parsed = new URL(uri);
    // Only local file URIs: empty host or `localhost`. A real remote host
    // (`file://server/share`) carries no usable local path -> null.
    if (parsed.host !== '' && parsed.host.toLowerCase() !== 'localhost') {
      return null;
    }
    let path = decodeURIComponent(parsed.pathname);
    // Windows drive URIs carry a leading slash before the drive letter
    // (`/C:/Users/…`); drop it so the result is a real drive-rooted path.
    if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
    return path;
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
