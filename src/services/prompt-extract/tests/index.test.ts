import { expect, test } from 'bun:test';

import { zstdCompressSync } from 'core/utils';
import type { BodyFormat, SourceApp } from 'services/contract';

import { extractConversation, extractUserPrompt } from 'services/prompt-extract';

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

test('dispatches gemini sqlite_rows_json bodies to the gemini extractor', () => {
  const text = JSON.stringify([
    { role: 'user', text: 'hello gemini', iso_timestamp: '2026-06-01T00:00:00.000Z' },
  ]);
  expect(extractUserPrompt(input(text, 'gemini', 'sqlite_rows_json'))).toEqual({
    userPrompt: 'hello gemini',
    userPromptAddedAt: '2026-06-01T00:00:00.000Z',
  });
});

test('returns null result when decoding throws unexpectedly', () => {
  const text = JSON.stringify({ type: 'user', content: 'hello claude' });
  const throwingDecode = (): string | null => {
    throw new Error('synthetic decode failure');
  };
  expect(extractUserPrompt(input(text, 'claude-code', 'jsonl'), throwingDecode)).toEqual({
    userPrompt: null,
    userPromptAddedAt: null,
  });
});

test('extracts user prompt and assistant response for claude-desktop jsonl', () => {
  const text = [
    JSON.stringify({ type: 'user', message: { content: 'desktop prompt' } }),
    JSON.stringify({ type: 'assistant', message: { content: 'desktop response' } }),
  ].join('\n');
  const result = extractConversation(input(text, 'claude-desktop', 'jsonl'));
  expect(result.userPrompt).toBe('desktop prompt');
  expect(result.assistantResponse).toBe('desktop response');
});

test('extractConversation returns user prompt and assistant response for jsonl', () => {
  const text = [
    JSON.stringify({ type: 'user', message: { content: 'do the thing' } }),
    JSON.stringify({ type: 'assistant', message: { content: 'done' } }),
  ].join('\n');
  expect(extractConversation(input(text, 'claude-code', 'jsonl'))).toEqual({
    userPrompt: 'do the thing',
    userPromptAddedAt: null,
    assistantResponse: 'done',
  });
});

test('extractConversation returns prompt and response for cursor kv pairs', () => {
  const body = JSON.stringify({
    rows: [
      { key: 'bubbleId:1', value: JSON.stringify({ type: 1, text: 'ask' }) },
      { key: 'bubbleId:2', value: JSON.stringify({ type: 2, text: 'reply' }) },
    ],
  });
  const result = extractConversation(input(body, 'cursor', 'kv_pairs_json'));
  expect(result.userPrompt).toBe('ask');
  expect(result.assistantResponse).toBe('reply');
});

test('extractConversation returns prompt and response for gemini sqlite rows', () => {
  const body = JSON.stringify([
    { role: 'user', text: 'ask gemini' },
    { role: 'assistant', text: 'gemini reply' },
  ]);
  const result = extractConversation(input(body, 'gemini', 'sqlite_rows_json'));
  expect(result.userPrompt).toBe('ask gemini');
  expect(result.assistantResponse).toBe('gemini reply');
});

test('extractConversation returns all-null for unsupported source/format combos', () => {
  expect(extractConversation(input('x', 'cursor', 'jsonl'))).toEqual({
    userPrompt: null,
    userPromptAddedAt: null,
    assistantResponse: null,
  });
});

test('extractConversation returns all-null when the body cannot be decompressed', () => {
  expect(
    extractConversation({
      sourceApp: 'claude-code',
      bodyFormat: 'jsonl',
      body: new Uint8Array([9, 9, 9]),
    }),
  ).toEqual({ userPrompt: null, userPromptAddedAt: null, assistantResponse: null });
});

test('extractConversation swallows a decode failure', () => {
  const throwingDecode = (): string => {
    throw new Error('decode boom');
  };
  expect(extractConversation(input('x', 'claude-code', 'jsonl'), throwingDecode)).toEqual({
    userPrompt: null,
    userPromptAddedAt: null,
    assistantResponse: null,
  });
});
