import type { BodyFormat, SourceApp } from 'services/contract';
import { decompressBody } from 'services/prompt-extract/decode.ts';
import { extractFromCursorKvPairs } from 'services/prompt-extract/cursor.ts';
import { extractFromJsonl } from 'services/prompt-extract/jsonl.ts';
import type { JsonlSourceApp } from 'services/prompt-extract/jsonl.ts';

export interface PromptExtractInput {
  sourceApp: SourceApp;
  bodyFormat: BodyFormat;
  body: Uint8Array;
}

export interface PromptExtractResult {
  userPrompt: string | null;
  userPromptAddedAt: string | null;
}

const NULL_RESULT: PromptExtractResult = { userPrompt: null, userPromptAddedAt: null };

const JSONL_SOURCE_APPS: ReadonlySet<SourceApp> = new Set(['claude-code', 'gemini-cli', 'codex']);

function isJsonlSourceApp(app: SourceApp): app is JsonlSourceApp {
  return JSONL_SOURCE_APPS.has(app);
}

export function extractUserPrompt(input: PromptExtractInput): PromptExtractResult {
  try {
    const text = decompressBody(input.body);
    if (text === null) return NULL_RESULT;

    if (input.bodyFormat === 'jsonl' && isJsonlSourceApp(input.sourceApp)) {
      return extractFromJsonl(text, input.sourceApp);
    }

    if (input.bodyFormat === 'kv_pairs_json' && input.sourceApp === 'cursor') {
      return extractFromCursorKvPairs(text);
    }

    return NULL_RESULT;
  } catch {
    return NULL_RESULT;
  }
}
