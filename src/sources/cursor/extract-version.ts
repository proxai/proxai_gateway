import {
  CURSOR_DEFAULT_AGENT_SCHEMA_VERSION,
  CURSOR_KEY_PREFIX_BUBBLE,
  CURSOR_KEY_PREFIX_COMPOSER,
} from 'sources/cursor/cursor.constants.ts';
import type { CursorDiskKvRow } from 'sources/cursor/cursor.types.ts';

export interface CursorSchemaAxes {
  composer: string | null;
  bubble: string | null;
}

/**
 * Highest `_v` per prefix among `rows`. `null` for an axis whose prefix has no
 * row with a parseable numeric `_v`.
 *
 * MAX, not first-by-rowid: a long-lived cursorDiskKV file accumulates ancient
 * artifacts (bubble `_v=2`, composer `_v=1`) next to current ones (`_v=3`/`16`).
 * Taking the first row in rowid order let an old — or later-dropped — row stamp
 * a batch whose body is entirely current-version content (the `1:2` mislabel
 * nest rejected). MAX makes the newest schema present win, so a batch is never
 * labeled below the version it actually carries.
 */
export function computeCursorSchemaAxes(rows: readonly CursorDiskKvRow[]): CursorSchemaAxes {
  let composer: number | null = null;
  let bubble: number | null = null;

  for (const row of rows) {
    if (row.key.startsWith(CURSOR_KEY_PREFIX_COMPOSER)) {
      const v = parseInnerVersion(row.value);
      if (v !== null) composer = composer === null ? v : Math.max(composer, v);
    } else if (row.key.startsWith(CURSOR_KEY_PREFIX_BUBBLE)) {
      const v = parseInnerVersion(row.value);
      if (v !== null) bubble = bubble === null ? v : Math.max(bubble, v);
    }
  }

  return {
    composer: composer === null ? null : String(composer),
    bubble: bubble === null ? null : String(bubble),
  };
}

/**
 * Build the `composer:bubble` agent_schema_version for one batch.
 *
 * `fallbackComposer` (the cycle-level composer version) is used when this batch
 * has no composer rows of its own. Size-splitting can produce a bubble-only
 * batch; it must still carry a numeric composer so the backend's wide
 * `composer >= 1` gate passes — only the bubble axis is known-tolerated as
 * 'unknown', via the composer-only `<n>:unknown` path.
 *
 * If the whole cycle had no composer rows (`fallbackComposer` is null too), a
 * bubble-only batch is labeled `unknown:<bubble>` — rare (Cursor records a
 * composer for every bubble) and unchanged from pre-fix behavior for such files.
 * Returns the single token 'unknown' when nothing is known on either axis.
 */
export function formatAgentSchemaVersion(
  axes: CursorSchemaAxes,
  fallbackComposer: string | null = null,
): string {
  const composer = axes.composer ?? fallbackComposer ?? CURSOR_DEFAULT_AGENT_SCHEMA_VERSION;
  const bubble = axes.bubble ?? CURSOR_DEFAULT_AGENT_SCHEMA_VERSION;
  if (
    composer === CURSOR_DEFAULT_AGENT_SCHEMA_VERSION &&
    bubble === CURSOR_DEFAULT_AGENT_SCHEMA_VERSION
  ) {
    return CURSOR_DEFAULT_AGENT_SCHEMA_VERSION;
  }
  return `${composer}:${bubble}`;
}

/**
 * TEMPORARY shim — keeps `collect.ts` compiling until Task 2 rewires it to the
 * per-batch helpers above. Reproduces the legacy cycle-wide string shape but on
 * MAX semantics. Removed in Task 2.
 */
export function extractAgentSchemaVersion(rows: readonly CursorDiskKvRow[]): string {
  return formatAgentSchemaVersion(computeCursorSchemaAxes(rows));
}

function parseInnerVersion(value: string): number | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const v = parsed['_v'];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  } catch {
    return null;
  }
}
