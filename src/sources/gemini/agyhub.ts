import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { decodeAgyhubFolders } from 'services/exclusion';
import { GEMINI_AGYHUB_FILE } from 'sources/gemini/gemini.constants.ts';

/**
 * Read + decode <baseDir>/agyhub_summaries_proto.pb -> `{ folders, complete }`.
 *
 * `complete` is a fail-CLOSED signal callers gate on (pause, no capture, no cursor advance) so an
 * excluded conversation is never shipped merely because it is absent from an unusable index. It is
 * a TOP-LEVEL protobuf-frame consumed-all-bytes signal from decodeAgyhubFolders, BACKSTOPPED here
 * by an empty-map rule. It does NOT fully cover mid-write: a boundary-aligned partial where >=1
 * entry decoded but the excluded one was not yet appended still reports complete:true (no record
 * count oracle exists to detect that).
 *
 * Two distinct cases:
 *  - MISSING/unreadable file (readFileSync throws, e.g. ENOENT) -> fail-OPEN
 *    `{ folders: empty, complete: true }`: no index means there is no folder identity to protect,
 *    so capture proceeds normally.
 *  - PRESENT but unusable (read succeeds yet `bytes.length === 0`, OR the decode yields zero
 *    entries) -> fail-CLOSED `complete: false`: a transiently-empty/garbage `.pb` could simply be
 *    missing the excluded conversation, so pause until the index populates (backfills then).
 */
export function loadAgyhubFolderMap(baseDir: string): {
  folders: Map<string, string[]>;
  complete: boolean;
} {
  let bytes: Buffer;
  try {
    bytes = readFileSync(join(baseDir, GEMINI_AGYHUB_FILE));
  } catch {
    // MISSING/unreadable -> fail-open (nothing to protect).
    return { folders: new Map<string, string[]>(), complete: true };
  }
  // PRESENT-but-empty buffer -> fail-closed (mid-write/truncated; excluded conv may be absent).
  if (bytes.length === 0) {
    return { folders: new Map<string, string[]>(), complete: false };
  }
  const decoded = decodeAgyhubFolders(bytes);
  // PRESENT but decodes to ZERO entries -> fail-closed for the same reason; an index with no
  // mappings cannot prove an excluded conversation is genuinely absent.
  if (decoded.folders.size === 0) {
    return { folders: decoded.folders, complete: false };
  }
  return decoded;
}

/** brain/<uuid>/.system_generated/logs/transcript.jsonl -> <uuid> (empty string if no brain/ segment). */
export function geminiConversationIdFromPath(transcriptPath: string): string {
  // Split on BOTH separators, not node:path.sep: discovery (Bun.Glob) yields
  // `/`-separated paths even on Windows, while a native FS path uses `\`. Pinning
  // to `sep` would match only one of them per OS and return '' on the other.
  const parts = transcriptPath.split(/[/\\]/);
  const i = parts.lastIndexOf('brain');
  return i >= 0 && i + 1 < parts.length ? (parts[i + 1] ?? '') : '';
}
