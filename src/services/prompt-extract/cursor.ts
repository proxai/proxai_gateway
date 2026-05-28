import { isRecord } from 'core/utils';

const USER_PROMPT_MAX_CHARS = 2000;

export interface PromptResult {
  userPrompt: string | null;
  userPromptAddedAt: string | null;
}

interface KvRow {
  key: string;
  value: string;
}

function isKvRow(value: unknown): value is KvRow {
  return isRecord(value) && typeof value.key === 'string' && typeof value.value === 'string';
}

function timestampFromMs(ms: unknown): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return null;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

function extractFromBubble(row: KvRow): PromptResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.type !== 1) return null;
  if (typeof parsed.text !== 'string' || parsed.text.trim().length === 0) return null;

  const text = parsed.text.trim();
  const truncated = text.slice(0, USER_PROMPT_MAX_CHARS);
  const ts = timestampFromMs(parsed.createdAt);
  return { userPrompt: truncated, userPromptAddedAt: ts };
}

function extractFromAgentKvBlob(row: KvRow): PromptResult | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.value);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (parsed.role !== 'user') return null;

  const content = parsed.content;
  let text: string | null = null;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!isRecord(item)) continue;
      if (typeof item.text === 'string' && item.text.trim().length > 0) {
        text = item.text.trim();
        break;
      }
    }
  } else if (typeof content === 'string' && content.trim().length > 0) {
    text = content.trim();
  }
  if (text === null) return null;

  const truncated = text.slice(0, USER_PROMPT_MAX_CHARS);
  const ts = timestampFromMs(parsed.createdAt);
  return { userPrompt: truncated, userPromptAddedAt: ts };
}

export function extractFromCursorKvPairs(text: string): PromptResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { userPrompt: null, userPromptAddedAt: null };
  }
  if (!isRecord(parsed)) return { userPrompt: null, userPromptAddedAt: null };

  const rows = parsed.rows;
  if (!Array.isArray(rows)) return { userPrompt: null, userPromptAddedAt: null };

  for (const row of rows) {
    if (!isKvRow(row)) continue;

    if (row.key.startsWith('bubbleId:')) {
      const result = extractFromBubble(row);
      if (result !== null) return result;
    } else if (row.key.startsWith('agentKv:blob:')) {
      const result = extractFromAgentKvBlob(row);
      if (result !== null) return result;
    }
  }

  return { userPrompt: null, userPromptAddedAt: null };
}
