import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';

import { decodeAgyhubFolders } from 'services/exclusion';
import { GEMINI_AGYHUB_FILE } from 'sources/gemini/gemini.constants.ts';

/**
 * Read + decode <baseDir>/agyhub_summaries_proto.pb -> `{ folders, complete }`.
 *
 * `complete` carries the truncated-read contract from decodeAgyhubFolders: it is `false` when
 * the `.pb` was read mid-write and the top-level walk did not consume every byte. Callers gate
 * on it to fail CLOSED (pause, no capture, no cursor advance) rather than leak an excluded
 * conversation that is merely absent from a partial map.
 *
 * A MISSING/unreadable file (catch) is fail-open: `{ folders: new Map(), complete: true }` — a
 * missing index means there is no folder identity to protect, so capture proceeds normally.
 */
export function loadAgyhubFolderMap(baseDir: string): {
  folders: Map<string, string[]>;
  complete: boolean;
} {
  try {
    return decodeAgyhubFolders(readFileSync(join(baseDir, GEMINI_AGYHUB_FILE)));
  } catch {
    return { folders: new Map<string, string[]>(), complete: true };
  }
}

/** brain/<uuid>/.system_generated/logs/transcript.jsonl -> <uuid> (empty string if no brain/ segment). */
export function geminiConversationIdFromPath(transcriptPath: string): string {
  const parts = transcriptPath.split(sep);
  const i = parts.lastIndexOf('brain');
  return i >= 0 && i + 1 < parts.length ? (parts[i + 1] ?? '') : '';
}
