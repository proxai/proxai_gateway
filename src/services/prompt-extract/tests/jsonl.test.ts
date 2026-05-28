import { expect, test } from 'bun:test';

import { extractFromJsonl } from 'services/prompt-extract/jsonl.ts';

function jsonl(...records: unknown[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n');
}

test('skips blank lines, malformed JSON lines, and non-record lines', () => {
  const text = ['', '   ', 'not json {', '"a string"', '42'].join('\n');
  expect(extractFromJsonl(text, 'claude-code')).toEqual({
    userPrompt: null,
    userPromptAddedAt: null,
  });
});

test('claude-code: extracts from message.content string with timestamp', () => {
  const text = jsonl({
    type: 'user',
    message: { content: 'fix the bug please' },
    timestamp: '2026-01-02T03:04:05.000Z',
  });
  expect(extractFromJsonl(text, 'claude-code')).toEqual({
    userPrompt: 'fix the bug please',
    userPromptAddedAt: '2026-01-02T03:04:05.000Z',
  });
});

test('claude-code: non-user records are skipped', () => {
  const text = jsonl({ type: 'assistant', message: { content: 'hi' } });
  expect(extractFromJsonl(text, 'claude-code')).toEqual({
    userPrompt: null,
    userPromptAddedAt: null,
  });
});

test('claude-code: falls back to record content when message is absent', () => {
  const text = jsonl({ type: 'user', content: 'top-level content' });
  expect(extractFromJsonl(text, 'claude-code')).toEqual({
    userPrompt: 'top-level content',
    userPromptAddedAt: null,
  });
});

test('claude-code: falls back to message.text when no content present', () => {
  const text = jsonl({ type: 'user', message: { text: 'message text field' } });
  expect(extractFromJsonl(text, 'claude-code')).toEqual({
    userPrompt: 'message text field',
    userPromptAddedAt: null,
  });
});

test('claude-code: falls back to record text when only top-level text present', () => {
  const text = jsonl({ type: 'user', text: 'bare text field' });
  expect(extractFromJsonl(text, 'claude-code')).toEqual({
    userPrompt: 'bare text field',
    userPromptAddedAt: null,
  });
});

test('claude-code: message.content null falls through to message.text', () => {
  const text = jsonl({ type: 'user', message: { content: null, text: 'after null content' } });
  expect(extractFromJsonl(text, 'claude-code')).toEqual({
    userPrompt: 'after null content',
    userPromptAddedAt: null,
  });
});

test('claude-code: record with no extractable content yields null', () => {
  const text = jsonl({ type: 'user', message: {} });
  expect(extractFromJsonl(text, 'claude-code')).toEqual({
    userPrompt: null,
    userPromptAddedAt: null,
  });
});

test('claude-code: extracts text from a content array of typed blocks', () => {
  const text = jsonl({
    type: 'user',
    message: {
      content: [{ type: 'image' }, { type: 'text', text: 'the array text' }],
    },
  });
  expect(extractFromJsonl(text, 'claude-code')).toEqual({
    userPrompt: 'the array text',
    userPromptAddedAt: null,
  });
});

test('claude-code: content array with non-record items is tolerated', () => {
  const text = jsonl({
    type: 'user',
    message: { content: ['raw string', { type: 'text', text: 'block text' }] },
  });
  expect(extractFromJsonl(text, 'claude-code')).toEqual({
    userPrompt: 'block text',
    userPromptAddedAt: null,
  });
});

test('claude-code: content array with no usable text yields null', () => {
  const text = jsonl({
    type: 'user',
    message: { content: [{ type: 'text', text: '   ' }, { type: 'image' }] },
  });
  expect(extractFromJsonl(text, 'claude-code')).toEqual({
    userPrompt: null,
    userPromptAddedAt: null,
  });
});

test('claude-code: single record content block is extracted', () => {
  const text = jsonl({ type: 'user', content: { type: 'text', text: 'single block' } });
  expect(extractFromJsonl(text, 'claude-code')).toEqual({
    userPrompt: 'single block',
    userPromptAddedAt: null,
  });
});

test('claude-code: single record content block with empty text yields null', () => {
  const text = jsonl({ type: 'user', content: { type: 'text', text: '   ' } });
  expect(extractFromJsonl(text, 'claude-code')).toEqual({
    userPrompt: null,
    userPromptAddedAt: null,
  });
});

test('claude-code: record content object that is not a text block yields null', () => {
  const text = jsonl({ type: 'user', content: { type: 'image', url: 'x' } });
  expect(extractFromJsonl(text, 'claude-code')).toEqual({
    userPrompt: null,
    userPromptAddedAt: null,
  });
});

test('claude-code: empty string content yields null', () => {
  const text = jsonl({ type: 'user', content: '' });
  expect(extractFromJsonl(text, 'claude-code')).toEqual({
    userPrompt: null,
    userPromptAddedAt: null,
  });
});

test('claude-code: synthetic-prefixed prompts are filtered out', () => {
  const text = jsonl({ type: 'user', content: '<bash-input> ls -la' });
  expect(extractFromJsonl(text, 'claude-code')).toEqual({
    userPrompt: null,
    userPromptAddedAt: null,
  });
});

test('claude-code: tool_result inside a content array is filtered out', () => {
  const text = jsonl({
    type: 'user',
    message: { content: [{ type: 'tool_result', content: 'done' }] },
  });
  expect(extractFromJsonl(text, 'claude-code')).toEqual({
    userPrompt: null,
    userPromptAddedAt: null,
  });
});

test('claude-code: tool_result as a single content object is filtered out', () => {
  const text = jsonl({ type: 'user', content: { type: 'tool_result', x: 1 } });
  expect(extractFromJsonl(text, 'claude-code')).toEqual({
    userPrompt: null,
    userPromptAddedAt: null,
  });
});

test('claude-code: empty timestamp string is treated as no timestamp', () => {
  const text = jsonl({ type: 'user', content: 'hello', timestamp: '' });
  expect(extractFromJsonl(text, 'claude-code')).toEqual({
    userPrompt: 'hello',
    userPromptAddedAt: null,
  });
});

test('claude-code: user prompt is truncated to 2000 characters', () => {
  const long = 'y'.repeat(2500);
  const result = extractFromJsonl(jsonl({ type: 'user', content: long }), 'claude-code');
  expect(result.userPrompt).toHaveLength(2000);
});

test('gemini-cli: extracts user content with timestamp', () => {
  const text = jsonl({
    type: 'user',
    content: 'gemini question',
    timestamp: '2026-02-02T00:00:00.000Z',
  });
  expect(extractFromJsonl(text, 'gemini-cli')).toEqual({
    userPrompt: 'gemini question',
    userPromptAddedAt: '2026-02-02T00:00:00.000Z',
  });
});

test('gemini-cli: non-user records are skipped', () => {
  const text = jsonl({ type: 'model', content: 'response' });
  expect(extractFromJsonl(text, 'gemini-cli')).toEqual({
    userPrompt: null,
    userPromptAddedAt: null,
  });
});

test('gemini-cli: user record with no usable content yields null', () => {
  const text = jsonl({ type: 'user', content: '' });
  expect(extractFromJsonl(text, 'gemini-cli')).toEqual({
    userPrompt: null,
    userPromptAddedAt: null,
  });
});

test('codex: extracts user message from a response_item payload with payload timestamp', () => {
  const text = jsonl({
    type: 'response_item',
    timestamp: '2026-03-01T00:00:00.000Z',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'text', text: 'codex prompt' }],
      timestamp: '2026-03-02T00:00:00.000Z',
    },
  });
  expect(extractFromJsonl(text, 'codex')).toEqual({
    userPrompt: 'codex prompt',
    userPromptAddedAt: '2026-03-02T00:00:00.000Z',
  });
});

test('codex: falls back to the record timestamp when payload timestamp is absent', () => {
  const text = jsonl({
    type: 'response_item',
    timestamp: '2026-03-01T00:00:00.000Z',
    payload: { type: 'message', role: 'user', content: 'codex via record ts' },
  });
  expect(extractFromJsonl(text, 'codex')).toEqual({
    userPrompt: 'codex via record ts',
    userPromptAddedAt: '2026-03-01T00:00:00.000Z',
  });
});

test('codex: empty payload timestamp falls back to record timestamp', () => {
  const text = jsonl({
    type: 'response_item',
    timestamp: '2026-03-01T00:00:00.000Z',
    payload: { type: 'message', role: 'user', content: 'codex', timestamp: '' },
  });
  expect(extractFromJsonl(text, 'codex')).toEqual({
    userPrompt: 'codex',
    userPromptAddedAt: '2026-03-01T00:00:00.000Z',
  });
});

test('codex: non response_item records are skipped', () => {
  const text = jsonl({ type: 'session_meta', payload: {} });
  expect(extractFromJsonl(text, 'codex')).toEqual({
    userPrompt: null,
    userPromptAddedAt: null,
  });
});

test('codex: response_item with a non-record payload is skipped', () => {
  const text = jsonl({ type: 'response_item', payload: 'oops' });
  expect(extractFromJsonl(text, 'codex')).toEqual({
    userPrompt: null,
    userPromptAddedAt: null,
  });
});

test('codex: payload that is not a user message is skipped', () => {
  const text = jsonl({
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: 'reply' },
  });
  expect(extractFromJsonl(text, 'codex')).toEqual({
    userPrompt: null,
    userPromptAddedAt: null,
  });
});

test('codex: user message payload with no usable content yields null', () => {
  const text = jsonl({
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: '' },
  });
  expect(extractFromJsonl(text, 'codex')).toEqual({
    userPrompt: null,
    userPromptAddedAt: null,
  });
});

test('returns the first matching prompt across multiple lines', () => {
  const text = jsonl(
    { type: 'assistant', content: 'reply' },
    { type: 'user', content: 'first user line' },
    { type: 'user', content: 'second user line' },
  );
  expect(extractFromJsonl(text, 'claude-code')).toEqual({
    userPrompt: 'first user line',
    userPromptAddedAt: null,
  });
});
