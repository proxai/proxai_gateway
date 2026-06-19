import { readFileSync } from 'node:fs';
import { join, sep } from 'node:path';

import { decodeAgyhubFolders } from 'services/exclusion';
import { GEMINI_AGYHUB_FILE } from 'sources/gemini/gemini.constants.ts';

/** Read + decode <baseDir>/agyhub_summaries_proto.pb -> Map<conversationUuid, folderPaths>. Missing/unreadable -> empty map (fail-open: no folder => captured). */
export function loadAgyhubFolderMap(baseDir: string): Map<string, string[]> {
  try {
    return decodeAgyhubFolders(readFileSync(join(baseDir, GEMINI_AGYHUB_FILE)));
  } catch {
    return new Map<string, string[]>();
  }
}

/** brain/<uuid>/.system_generated/logs/transcript.jsonl -> <uuid> (empty string if no brain/ segment). */
export function geminiConversationIdFromPath(transcriptPath: string): string {
  const parts = transcriptPath.split(sep);
  const i = parts.lastIndexOf('brain');
  return i >= 0 && i + 1 < parts.length ? (parts[i + 1] ?? '') : '';
}
