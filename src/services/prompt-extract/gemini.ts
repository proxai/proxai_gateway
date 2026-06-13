import { isRecord } from 'core/utils';

const USER_PROMPT_MAX_CHARS = 2000;

export interface PromptResult {
  userPrompt: string | null;
  userPromptAddedAt: string | null;
}

function timestampFromRow(row: Record<string, unknown>): string | null {
  if (typeof row.iso_timestamp === 'string' && row.iso_timestamp.length > 0) {
    return row.iso_timestamp;
  }
  return null;
}

export function extractFromGeminiRows(text: string): PromptResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { userPrompt: null, userPromptAddedAt: null };
  }
  if (!Array.isArray(parsed)) return { userPrompt: null, userPromptAddedAt: null };

  for (const row of parsed) {
    if (!isRecord(row)) continue;
    if (row.role !== 'user') continue;
    if (typeof row.text !== 'string' || row.text.trim().length === 0) continue;

    return {
      userPrompt: row.text.trim().slice(0, USER_PROMPT_MAX_CHARS),
      userPromptAddedAt: timestampFromRow(row),
    };
  }

  return { userPrompt: null, userPromptAddedAt: null };
}

export function extractAssistantFromGeminiRows(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  for (const row of parsed) {
    if (!isRecord(row)) continue;
    if (row.role !== 'assistant') continue;
    if (typeof row.text !== 'string' || row.text.trim().length === 0) continue;

    return row.text.trim().slice(0, USER_PROMPT_MAX_CHARS);
  }

  return null;
}
