import { expect, test } from 'bun:test';

import {
  extractAssistantFromCursorKvPairs,
  extractFromCursorKvPairs,
} from 'services/prompt-extract/cursor.ts';

interface SyntheticRow {
  key: string;
  value: string;
}

function kvBody(rows: unknown): string {
  return JSON.stringify({ rows });
}

function bubbleRow(key: string, payload: unknown): SyntheticRow {
  return { key, value: JSON.stringify(payload) };
}

test('returns null result when the text is not valid JSON', () => {
  expect(extractFromCursorKvPairs('not json {')).toEqual({
    userPrompt: null,
    userPromptAddedAt: null,
  });
});

test('returns null result when the parsed value is not a record', () => {
  expect(extractFromCursorKvPairs(JSON.stringify([1, 2, 3]))).toEqual({
    userPrompt: null,
    userPromptAddedAt: null,
  });
});

test('returns null result when rows is missing or not an array', () => {
  expect(extractFromCursorKvPairs(JSON.stringify({ rows: 'nope' }))).toEqual({
    userPrompt: null,
    userPromptAddedAt: null,
  });
});

test('skips rows that are not valid key/value pairs', () => {
  const rows = [{ key: 'bubbleId:x', value: 42 }, { key: 123, value: 'str' }, 'plain-string-row'];
  expect(extractFromCursorKvPairs(kvBody(rows))).toEqual({
    userPrompt: null,
    userPromptAddedAt: null,
  });
});

test('extracts a user prompt from a bubble row with a millisecond timestamp', () => {
  const createdAt = Date.UTC(2026, 0, 2, 3, 4, 5);
  const rows = [
    bubbleRow('bubbleId:session:b-001', {
      type: 1,
      text: '  please refactor the parser  ',
      createdAt,
    }),
  ];
  expect(extractFromCursorKvPairs(kvBody(rows))).toEqual({
    userPrompt: 'please refactor the parser',
    userPromptAddedAt: new Date(createdAt).toISOString(),
  });
});

test('bubble row with non-positive createdAt yields a null timestamp', () => {
  const rows = [bubbleRow('bubbleId:s:b', { type: 1, text: 'hi', createdAt: 0 })];
  expect(extractFromCursorKvPairs(kvBody(rows))).toEqual({
    userPrompt: 'hi',
    userPromptAddedAt: null,
  });
});

test('bubble row with non-numeric createdAt yields a null timestamp', () => {
  const rows = [bubbleRow('bubbleId:s:b', { type: 1, text: 'hi', createdAt: 'soon' })];
  expect(extractFromCursorKvPairs(kvBody(rows))).toEqual({
    userPrompt: 'hi',
    userPromptAddedAt: null,
  });
});

test('bubble row with non-finite createdAt yields a null timestamp', () => {
  const rows = [
    bubbleRow('bubbleId:s:b', { type: 1, text: 'hi', createdAt: Number.POSITIVE_INFINITY }),
  ];
  expect(extractFromCursorKvPairs(kvBody(rows))).toEqual({
    userPrompt: 'hi',
    userPromptAddedAt: null,
  });
});

test('bubble row with an out-of-range createdAt is caught and yields a null timestamp', () => {
  const outOfRange = 8.64e15 + 1;
  const rows = [bubbleRow('bubbleId:s:b', { type: 1, text: 'hi', createdAt: outOfRange })];
  expect(extractFromCursorKvPairs(kvBody(rows))).toEqual({
    userPrompt: 'hi',
    userPromptAddedAt: null,
  });
});

test('bubble row with invalid JSON value is skipped', () => {
  const rows = [{ key: 'bubbleId:s:b', value: '{ not json' }];
  expect(extractFromCursorKvPairs(kvBody(rows))).toEqual({
    userPrompt: null,
    userPromptAddedAt: null,
  });
});

test('bubble row whose JSON is not a record is skipped', () => {
  const rows = [{ key: 'bubbleId:s:b', value: '"just a string"' }];
  expect(extractFromCursorKvPairs(kvBody(rows))).toEqual({
    userPrompt: null,
    userPromptAddedAt: null,
  });
});

test('bubble row of the wrong type (assistant) is skipped', () => {
  const rows = [bubbleRow('bubbleId:s:b', { type: 2, text: 'assistant reply' })];
  expect(extractFromCursorKvPairs(kvBody(rows))).toEqual({
    userPrompt: null,
    userPromptAddedAt: null,
  });
});

test('bubble row with non-string text is skipped', () => {
  const rows = [bubbleRow('bubbleId:s:b', { type: 1, text: 99 })];
  expect(extractFromCursorKvPairs(kvBody(rows))).toEqual({
    userPrompt: null,
    userPromptAddedAt: null,
  });
});

test('bubble row with whitespace-only text is skipped', () => {
  const rows = [bubbleRow('bubbleId:s:b', { type: 1, text: '   ' })];
  expect(extractFromCursorKvPairs(kvBody(rows))).toEqual({
    userPrompt: null,
    userPromptAddedAt: null,
  });
});

test('bubble user prompt is truncated to 2000 characters', () => {
  const long = 'x'.repeat(2500);
  const rows = [bubbleRow('bubbleId:s:b', { type: 1, text: long })];
  const result = extractFromCursorKvPairs(kvBody(rows));
  expect(result.userPrompt).toHaveLength(2000);
});

test('extracts a user prompt from an agentKv blob with string content', () => {
  const createdAt = Date.UTC(2026, 1, 3);
  const rows = [
    bubbleRow('agentKv:blob:123', {
      role: 'user',
      content: '  hello from agent kv  ',
      createdAt,
    }),
  ];
  expect(extractFromCursorKvPairs(kvBody(rows))).toEqual({
    userPrompt: 'hello from agent kv',
    userPromptAddedAt: new Date(createdAt).toISOString(),
  });
});

test('extracts a user prompt from an agentKv blob with array content', () => {
  const rows = [
    bubbleRow('agentKv:blob:123', {
      role: 'user',
      content: [{ notText: true }, 'skip-string', { text: '   array item text   ' }],
    }),
  ];
  expect(extractFromCursorKvPairs(kvBody(rows))).toEqual({
    userPrompt: 'array item text',
    userPromptAddedAt: null,
  });
});

test('agentKv blob array content with no usable text yields null result', () => {
  const rows = [
    bubbleRow('agentKv:blob:1', {
      role: 'user',
      content: [{ text: '   ' }, { text: 42 }],
    }),
  ];
  expect(extractFromCursorKvPairs(kvBody(rows))).toEqual({
    userPrompt: null,
    userPromptAddedAt: null,
  });
});

test('agentKv blob with empty string content yields null result', () => {
  const rows = [bubbleRow('agentKv:blob:1', { role: 'user', content: '   ' })];
  expect(extractFromCursorKvPairs(kvBody(rows))).toEqual({
    userPrompt: null,
    userPromptAddedAt: null,
  });
});

test('agentKv blob with non-array non-string content yields null result', () => {
  const rows = [bubbleRow('agentKv:blob:1', { role: 'user', content: { nested: true } })];
  expect(extractFromCursorKvPairs(kvBody(rows))).toEqual({
    userPrompt: null,
    userPromptAddedAt: null,
  });
});

test('agentKv blob with invalid JSON value is skipped', () => {
  const rows = [{ key: 'agentKv:blob:1', value: 'not json' }];
  expect(extractFromCursorKvPairs(kvBody(rows))).toEqual({
    userPrompt: null,
    userPromptAddedAt: null,
  });
});

test('agentKv blob whose JSON is not a record is skipped', () => {
  const rows = [{ key: 'agentKv:blob:1', value: '12345' }];
  expect(extractFromCursorKvPairs(kvBody(rows))).toEqual({
    userPrompt: null,
    userPromptAddedAt: null,
  });
});

test('agentKv blob of the wrong role is skipped', () => {
  const rows = [bubbleRow('agentKv:blob:1', { role: 'assistant', content: 'reply' })];
  expect(extractFromCursorKvPairs(kvBody(rows))).toEqual({
    userPrompt: null,
    userPromptAddedAt: null,
  });
});

test('rows with unrelated key prefixes are ignored entirely', () => {
  const rows = [bubbleRow('composerData:1', { _v: 13 }), bubbleRow('checkpointId:42', {})];
  expect(extractFromCursorKvPairs(kvBody(rows))).toEqual({
    userPrompt: null,
    userPromptAddedAt: null,
  });
});

test('continues past a non-matching bubble row to a later matching one', () => {
  const rows = [
    bubbleRow('bubbleId:s:b1', { type: 2, text: 'assistant' }),
    bubbleRow('agentKv:blob:1', { role: 'assistant', content: 'reply' }),
    bubbleRow('bubbleId:s:b2', { type: 1, text: 'the real prompt' }),
  ];
  expect(extractFromCursorKvPairs(kvBody(rows))).toEqual({
    userPrompt: 'the real prompt',
    userPromptAddedAt: null,
  });
});

test('extractAssistantFromCursorKvPairs reads an assistant bubble (type 2)', () => {
  const body = kvBody([bubbleRow('bubbleId:1', { type: 2, text: 'assistant says hi' })]);
  expect(extractAssistantFromCursorKvPairs(body)).toBe('assistant says hi');
});

test('extractAssistantFromCursorKvPairs reads an assistant agentKv blob', () => {
  const body = kvBody([
    bubbleRow('agentKv:blob:1', { role: 'assistant', content: [{ text: 'blob answer' }] }),
  ]);
  expect(extractAssistantFromCursorKvPairs(body)).toBe('blob answer');
});

test('extractAssistantFromCursorKvPairs reads an assistant blob with string content', () => {
  const body = kvBody([
    bubbleRow('agentKv:blob:1', { role: 'assistant', content: 'plain answer' }),
  ]);
  expect(extractAssistantFromCursorKvPairs(body)).toBe('plain answer');
});

test('extractAssistantFromCursorKvPairs returns null for non-assistant or invalid input', () => {
  expect(extractAssistantFromCursorKvPairs('not json {')).toBeNull();
  expect(extractAssistantFromCursorKvPairs(JSON.stringify({ rows: 'x' }))).toBeNull();
  expect(extractAssistantFromCursorKvPairs(JSON.stringify('a string'))).toBeNull();
  expect(
    extractAssistantFromCursorKvPairs(kvBody([bubbleRow('bubbleId:1', { type: 1, text: 'u' })])),
  ).toBeNull();
  expect(
    extractAssistantFromCursorKvPairs(kvBody([bubbleRow('bubbleId:1', 'not json {')])),
  ).toBeNull();
  expect(
    extractAssistantFromCursorKvPairs(kvBody([bubbleRow('agentKv:blob:1', { role: 'user' })])),
  ).toBeNull();
  expect(
    extractAssistantFromCursorKvPairs(
      kvBody([bubbleRow('agentKv:blob:1', { role: 'assistant', content: [{}] })]),
    ),
  ).toBeNull();
  expect(extractAssistantFromCursorKvPairs(kvBody([{ key: 'other:1', value: '{}' }]))).toBeNull();
});

test('extractAssistantFromCursorKvPairs swallows an invalid-JSON bubble value', () => {
  const body = JSON.stringify({ rows: [{ key: 'bubbleId:1', value: 'not json {' }] });
  expect(extractAssistantFromCursorKvPairs(body)).toBeNull();
});

test('extractAssistantFromCursorKvPairs swallows an invalid-JSON agentKv blob value', () => {
  const body = JSON.stringify({ rows: [{ key: 'agentKv:blob:1', value: 'not json {' }] });
  expect(extractAssistantFromCursorKvPairs(body)).toBeNull();
});
