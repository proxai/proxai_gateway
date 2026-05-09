import {
  CURSOR_DEFAULT_AGENT_SCHEMA_VERSION,
  CURSOR_KEY_PREFIX_BUBBLE,
  CURSOR_KEY_PREFIX_COMPOSER,
} from 'sources/cursor/cursor.constants.ts';
import type { CursorDiskKvRow } from 'sources/cursor/cursor.types.ts';

export function extractAgentSchemaVersion(rows: CursorDiskKvRow[]): string {
  let composerVersion: string | null = null;
  let bubbleVersion: string | null = null;

  for (const row of rows) {
    if (composerVersion === null && row.key.startsWith(CURSOR_KEY_PREFIX_COMPOSER)) {
      composerVersion = parseInnerVersion(row.value);
    }
    if (bubbleVersion === null && row.key.startsWith(CURSOR_KEY_PREFIX_BUBBLE)) {
      bubbleVersion = parseInnerVersion(row.value);
    }
    if (composerVersion !== null && bubbleVersion !== null) break;
  }

  if (composerVersion === null && bubbleVersion === null) {
    return CURSOR_DEFAULT_AGENT_SCHEMA_VERSION;
  }
  return `${composerVersion ?? CURSOR_DEFAULT_AGENT_SCHEMA_VERSION}:${bubbleVersion ?? CURSOR_DEFAULT_AGENT_SCHEMA_VERSION}`;
}

function parseInnerVersion(value: string): string | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const v = parsed['_v'];
    if (typeof v === 'number' || typeof v === 'string') {
      return String(v);
    }
    return null;
  } catch {
    return null;
  }
}
