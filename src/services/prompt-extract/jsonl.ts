import { isRecord } from 'core/utils';

const USER_PROMPT_MAX_CHARS = 2000;

export interface PromptResult {
  userPrompt: string | null;
  userPromptAddedAt: string | null;
}

function extractTextFromContent(content: unknown): string | null {
  if (typeof content === 'string') {
    return content.trim().length > 0 ? content : null;
  }
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!isRecord(item)) continue;
      if (item.type === 'text' && typeof item.text === 'string' && item.text.trim().length > 0) {
        return item.text;
      }
    }
    return null;
  }
  if (isRecord(content) && content.type === 'text' && typeof content.text === 'string') {
    return content.text.trim().length > 0 ? content.text : null;
  }
  return null;
}

function timestampFromRecord(rec: Record<string, unknown>): string | null {
  if (typeof rec.timestamp === 'string' && rec.timestamp.length > 0) {
    return rec.timestamp;
  }
  return null;
}

function extractClaudeCodeUserPrompt(rec: Record<string, unknown>): PromptResult | null {
  if (rec.type !== 'user') return null;

  const mContent = isRecord(rec.message) ? rec.message.content : undefined;
  const pContent = rec.content;
  const mText = isRecord(rec.message) ? rec.message.text : undefined;
  const pText = rec.text;

  const actualContent =
    mContent !== undefined && mContent !== null
      ? mContent
      : pContent !== undefined && pContent !== null
        ? pContent
        : mText !== undefined && mText !== null
          ? mText
          : pText;

  const text = extractTextFromContent(actualContent);
  if (text === null) return null;

  const trimmed = text.trimStart();
  const syntheticPrefixes = [
    '<bash-input>',
    '<bash-stdout>',
    '<bash-stderr>',
    '<local-command-stdout>',
    '<local-command-stderr>',
    '<command-name>',
    '<command-message>',
    '<command-args>',
    '<system-reminder>',
    '<local-command-caveat>',
  ];
  if (syntheticPrefixes.some((p) => trimmed.startsWith(p))) return null;

  const hasToolResult = (content: unknown): boolean => {
    if (!Array.isArray(content)) {
      return isRecord(content) && content.type === 'tool_result';
    }
    return content.some((item) => isRecord(item) && item.type === 'tool_result');
  };
  if (hasToolResult(mContent) || hasToolResult(pContent)) return null;

  const truncated = text.slice(0, USER_PROMPT_MAX_CHARS);
  const ts = timestampFromRecord(rec);
  return { userPrompt: truncated, userPromptAddedAt: ts };
}

function extractCodexRolloutUserPrompt(rec: Record<string, unknown>): PromptResult | null {
  if (rec.type !== 'response_item') return null;
  if (!isRecord(rec.payload)) return null;
  const payload = rec.payload;
  if (payload.type !== 'message' || payload.role !== 'user') return null;

  const text = extractTextFromContent(payload.content);
  if (text === null) return null;

  const truncated = text.slice(0, USER_PROMPT_MAX_CHARS);
  const ts =
    typeof payload.timestamp === 'string' && payload.timestamp.length > 0
      ? payload.timestamp
      : timestampFromRecord(rec);
  return { userPrompt: truncated, userPromptAddedAt: ts };
}

function resolveDialogueContent(rec: Record<string, unknown>): unknown {
  const mContent = isRecord(rec.message) ? rec.message.content : undefined;
  const pContent = rec.content;
  const mText = isRecord(rec.message) ? rec.message.text : undefined;
  const pText = rec.text;
  return mContent !== undefined && mContent !== null
    ? mContent
    : pContent !== undefined && pContent !== null
      ? pContent
      : mText !== undefined && mText !== null
        ? mText
        : pText;
}

function extractClaudeCodeAssistant(rec: Record<string, unknown>): string | null {
  if (rec.type !== 'assistant') return null;
  return extractTextFromContent(resolveDialogueContent(rec));
}

function extractCodexAssistant(rec: Record<string, unknown>): string | null {
  if (rec.type !== 'response_item') return null;
  if (!isRecord(rec.payload)) return null;
  const payload = rec.payload;
  if (payload.type !== 'message' || payload.role !== 'assistant') return null;
  return extractTextFromContent(payload.content);
}

export type JsonlSourceApp = 'claude-code' | 'codex' | 'claude-desktop';

export function extractAssistantFromJsonl(text: string, sourceApp: JsonlSourceApp): string | null {
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;

    let response: string | null = null;
    if (sourceApp === 'codex') {
      response = extractCodexAssistant(parsed);
    } else {
      response = extractClaudeCodeAssistant(parsed);
    }
    if (response !== null) return response;
  }
  return null;
}

export function extractFromJsonl(text: string, sourceApp: JsonlSourceApp): PromptResult {
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;

    let result: PromptResult | null = null;
    if (sourceApp === 'codex') {
      result = extractCodexRolloutUserPrompt(parsed);
    } else {
      result = extractClaudeCodeUserPrompt(parsed);
    }
    if (result !== null) return result;
  }
  return { userPrompt: null, userPromptAddedAt: null };
}
