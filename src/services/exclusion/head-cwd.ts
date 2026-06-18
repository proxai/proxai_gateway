// src/services/exclusion/head-cwd.ts
import { readJsonlRange } from 'core/io/jsonl';

// cwd appears on the first user/assistant turn (claude-code) or the session_meta
// first line (codex rollout) — always near byte 0. 1MB covers every realistic file;
// a file whose first cwd sits beyond 1MB fails open (rare). Bounded, stateless.
export const HEAD_SCAN_BYTES = 1024 * 1024;

/**
 * Read the head of a JSONL file (from byte 0, up to HEAD_SCAN_BYTES) and return the
 * first record's non-empty top-level `cwd` string, or null if none is found.
 * Uses a private TextDecoder so a partial multi-byte sequence at the scan boundary
 * cannot perturb any other decode.
 */
export async function resolveCwdFromHead(
  sourcePath: string,
  sizeBytes: number,
): Promise<string | null> {
  const end = Math.min(sizeBytes, HEAD_SCAN_BYTES);
  if (end <= 0) return null;
  const head = await readJsonlRange(sourcePath, 0, end);
  const decoder = new TextDecoder('utf-8', { fatal: false });
  for (const line of decoder.decode(head.bytes).split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed.cwd === 'string' && parsed.cwd.length > 0) return parsed.cwd;
    } catch {}
  }
  return null;
}
