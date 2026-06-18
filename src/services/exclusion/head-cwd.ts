// src/services/exclusion/head-cwd.ts
import { readJsonlRange } from 'core/io/jsonl';

// cwd appears on the first user/assistant turn (claude-code) or the session_meta
// first line (codex rollout) — always near byte 0. 1MB covers every realistic file;
// a file whose first cwd sits beyond 1MB fails open (rare). Bounded, stateless.
export const HEAD_SCAN_BYTES = 1024 * 1024;

/**
 * Read the head of a JSONL file (from byte 0, up to HEAD_SCAN_BYTES) and return the
 * first non-empty cwd found in any record, or null if none is found.
 *
 * Lookup order (first non-empty wins):
 *   1. Top-level `cwd` — used by Claude Code dialogue records.
 *   2. `payload.cwd` — used by Codex rollout `session_meta` records where all
 *      meaningful fields are nested under `payload` (top-level keys are only
 *      `type`, `timestamp`, and `payload`).
 *
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
      const top = typeof parsed.cwd === 'string' && parsed.cwd.length > 0 ? parsed.cwd : null;
      const payload = parsed.payload;
      const nested =
        payload !== null &&
        typeof payload === 'object' &&
        typeof payload.cwd === 'string' &&
        payload.cwd.length > 0
          ? payload.cwd
          : null;
      const cwd = top ?? nested;
      if (cwd !== null) return cwd;
    } catch {}
  }
  return null;
}
