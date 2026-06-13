import { decompressBody } from 'services/prompt-extract/decode.ts';
import {
  extractAssistantFromCursorKvPairs,
  extractFromCursorKvPairs,
} from 'services/prompt-extract/cursor.ts';
import {
  extractAssistantFromGeminiRows,
  extractFromGeminiRows,
} from 'services/prompt-extract/gemini.ts';
import { extractAssistantFromJsonl, extractFromJsonl } from 'services/prompt-extract/jsonl.ts';
import type { JsonlSourceApp } from 'services/prompt-extract/jsonl.ts';

export interface PromptExtractInput {
  sourceApp: string;
  bodyFormat: string;
  body: Uint8Array;
}

export interface PromptExtractResult {
  userPrompt: string | null;
  userPromptAddedAt: string | null;
}

export interface ConversationResult {
  userPrompt: string | null;
  userPromptAddedAt: string | null;
  assistantResponse: string | null;
}

const NULL_RESULT: PromptExtractResult = { userPrompt: null, userPromptAddedAt: null };
const NULL_CONVERSATION: ConversationResult = {
  userPrompt: null,
  userPromptAddedAt: null,
  assistantResponse: null,
};

const JSONL_SOURCE_APPS: ReadonlySet<string> = new Set(['claude-code', 'codex', 'claude-desktop']);

function isJsonlSourceApp(app: string): app is JsonlSourceApp {
  return JSONL_SOURCE_APPS.has(app);
}

export function extractUserPrompt(
  input: PromptExtractInput,
  // Injectable so tests can force a decode failure without globally mocking
  // decode.ts — a process-wide mock leaks into decode.test.ts and drops the
  // real decompressBody's coverage on CI. Defaults to the real decoder.
  decompress: (body: Uint8Array) => string | null = decompressBody,
): PromptExtractResult {
  try {
    const text = decompress(input.body);
    if (text === null) return NULL_RESULT;

    if (input.bodyFormat === 'jsonl' && isJsonlSourceApp(input.sourceApp)) {
      return extractFromJsonl(text, input.sourceApp);
    }

    if (input.bodyFormat === 'kv_pairs_json' && input.sourceApp === 'cursor') {
      return extractFromCursorKvPairs(text);
    }

    if (input.bodyFormat === 'sqlite_rows_json' && input.sourceApp === 'gemini') {
      return extractFromGeminiRows(text);
    }

    return NULL_RESULT;
  } catch {
    return NULL_RESULT;
  }
}

export function extractConversation(
  input: PromptExtractInput,
  decompress: (body: Uint8Array) => string | null = decompressBody,
): ConversationResult {
  try {
    const text = decompress(input.body);
    if (text === null) return NULL_CONVERSATION;

    if (input.bodyFormat === 'jsonl' && isJsonlSourceApp(input.sourceApp)) {
      const prompt = extractFromJsonl(text, input.sourceApp);
      return {
        userPrompt: prompt.userPrompt,
        userPromptAddedAt: prompt.userPromptAddedAt,
        assistantResponse: extractAssistantFromJsonl(text, input.sourceApp),
      };
    }

    if (input.bodyFormat === 'kv_pairs_json' && input.sourceApp === 'cursor') {
      const prompt = extractFromCursorKvPairs(text);
      return {
        userPrompt: prompt.userPrompt,
        userPromptAddedAt: prompt.userPromptAddedAt,
        assistantResponse: extractAssistantFromCursorKvPairs(text),
      };
    }

    if (input.bodyFormat === 'sqlite_rows_json' && input.sourceApp === 'gemini') {
      const prompt = extractFromGeminiRows(text);
      return {
        userPrompt: prompt.userPrompt,
        userPromptAddedAt: prompt.userPromptAddedAt,
        assistantResponse: extractAssistantFromGeminiRows(text),
      };
    }

    return NULL_CONVERSATION;
  } catch {
    return NULL_CONVERSATION;
  }
}
