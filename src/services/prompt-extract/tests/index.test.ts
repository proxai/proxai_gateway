import { afterEach, expect, mock, test } from 'bun:test';

import { zstdCompressSync, zstdDecompressSync } from 'core/utils';
import type { BodyFormat, SourceApp } from 'services/contract';

const DECODER = new TextDecoder('utf-8', { fatal: false });
let decodeShouldThrow = false;

mock.module('services/prompt-extract/decode.ts', () => ({
  decompressBody: (body: Uint8Array): string | null => {
    if (decodeShouldThrow) throw new Error('synthetic decode failure');
    try {
      return DECODER.decode(zstdDecompressSync(body));
    } catch {
      return null;
    }
  },
}));

import { extractUserPrompt } from 'services/prompt-extract';

afterEach(() => {
  decodeShouldThrow = false;
});

function input(text: string, sourceApp: SourceApp, bodyFormat: BodyFormat) {
  return { sourceApp, bodyFormat, body: zstdCompressSync(text) };
}

test('returns null result when the body cannot be decompressed', () => {
  const result = extractUserPrompt({
    sourceApp: 'claude-code',
    bodyFormat: 'jsonl',
    body: new Uint8Array([9, 9, 9, 9]),
  });
  expect(result).toEqual({ userPrompt: null, userPromptAddedAt: null });
});

test('dispatches claude-code jsonl bodies to the jsonl extractor', () => {
  const text = JSON.stringify({ type: 'user', content: 'hello claude' });
  expect(extractUserPrompt(input(text, 'claude-code', 'jsonl'))).toEqual({
    userPrompt: 'hello claude',
    userPromptAddedAt: null,
  });
});

test('dispatches gemini-cli jsonl bodies to the jsonl extractor', () => {
  const text = JSON.stringify({ type: 'user', content: 'hello gemini' });
  expect(extractUserPrompt(input(text, 'gemini-cli', 'jsonl'))).toEqual({
    userPrompt: 'hello gemini',
    userPromptAddedAt: null,
  });
});

test('dispatches codex jsonl bodies to the jsonl extractor', () => {
  const text = JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: 'hello codex' },
  });
  expect(extractUserPrompt(input(text, 'codex', 'jsonl'))).toEqual({
    userPrompt: 'hello codex',
    userPromptAddedAt: null,
  });
});

test('dispatches cursor kv_pairs_json bodies to the cursor extractor', () => {
  const text = JSON.stringify({
    rows: [{ key: 'bubbleId:s:b', value: JSON.stringify({ type: 1, text: 'hello cursor' }) }],
  });
  expect(extractUserPrompt(input(text, 'cursor', 'kv_pairs_json'))).toEqual({
    userPrompt: 'hello cursor',
    userPromptAddedAt: null,
  });
});

test('returns null result for a recognized format with a mismatched source app', () => {
  const text = JSON.stringify({ rows: [] });
  expect(extractUserPrompt(input(text, 'claude-code', 'kv_pairs_json'))).toEqual({
    userPrompt: null,
    userPromptAddedAt: null,
  });
});

test('returns null result for jsonl format with a non-jsonl source app', () => {
  const text = JSON.stringify({ type: 'user', content: 'hi' });
  expect(extractUserPrompt(input(text, 'cursor', 'jsonl'))).toEqual({
    userPrompt: null,
    userPromptAddedAt: null,
  });
});

test('returns null result for the codex sqlite_rows_json fallthrough', () => {
  const text = JSON.stringify({ rows: [] });
  expect(extractUserPrompt(input(text, 'codex', 'sqlite_rows_json'))).toEqual({
    userPrompt: null,
    userPromptAddedAt: null,
  });
});

test('returns null result when decoding throws unexpectedly', () => {
  decodeShouldThrow = true;
  const text = JSON.stringify({ type: 'user', content: 'hello claude' });
  expect(extractUserPrompt(input(text, 'claude-code', 'jsonl'))).toEqual({
    userPrompt: null,
    userPromptAddedAt: null,
  });
});
