import { expect, test } from 'bun:test';

import {
  extractAssistantFromGeminiRows,
  extractFromGeminiRows,
} from 'services/prompt-extract/gemini.ts';

function rowsBody(rows: unknown): string {
  return JSON.stringify(rows);
}

test('returns null result when the text is not valid JSON', () => {
  expect(extractFromGeminiRows('not json [')).toEqual({
    userPrompt: null,
    userPromptAddedAt: null,
  });
});

test('returns null result when the parsed value is not an array', () => {
  expect(extractFromGeminiRows(JSON.stringify({ rows: [] }))).toEqual({
    userPrompt: null,
    userPromptAddedAt: null,
  });
});

test('extracts a user prompt from a user row with an iso timestamp', () => {
  const rows = [
    {
      role: 'user',
      text: '  please refactor the parser  ',
      iso_timestamp: '2026-01-02T03:04:05.000Z',
    },
  ];
  expect(extractFromGeminiRows(rowsBody(rows))).toEqual({
    userPrompt: 'please refactor the parser',
    userPromptAddedAt: '2026-01-02T03:04:05.000Z',
  });
});

test('user row without iso_timestamp yields a null timestamp', () => {
  const rows = [{ role: 'user', text: 'hello gemini' }];
  expect(extractFromGeminiRows(rowsBody(rows))).toEqual({
    userPrompt: 'hello gemini',
    userPromptAddedAt: null,
  });
});

test('user row with an empty-string iso_timestamp yields a null timestamp', () => {
  const rows = [{ role: 'user', text: 'hello gemini', iso_timestamp: '' }];
  expect(extractFromGeminiRows(rowsBody(rows))).toEqual({
    userPrompt: 'hello gemini',
    userPromptAddedAt: null,
  });
});

test('user row with a non-string iso_timestamp yields a null timestamp', () => {
  const rows = [{ role: 'user', text: 'hello gemini', iso_timestamp: 123 }];
  expect(extractFromGeminiRows(rowsBody(rows))).toEqual({
    userPrompt: 'hello gemini',
    userPromptAddedAt: null,
  });
});

test('user row with non-string text is skipped', () => {
  const rows = [{ role: 'user', text: 99 }];
  expect(extractFromGeminiRows(rowsBody(rows))).toEqual({
    userPrompt: null,
    userPromptAddedAt: null,
  });
});

test('user row with whitespace-only text is skipped', () => {
  const rows = [{ role: 'user', text: '   ' }];
  expect(extractFromGeminiRows(rowsBody(rows))).toEqual({
    userPrompt: null,
    userPromptAddedAt: null,
  });
});

test('non-user rows are skipped', () => {
  const rows = [
    { role: 'assistant', text: 'an answer' },
    { role: 'tool', text: 'tool output' },
    { role: 'system', text: 'system note' },
  ];
  expect(extractFromGeminiRows(rowsBody(rows))).toEqual({
    userPrompt: null,
    userPromptAddedAt: null,
  });
});

test('elements that are not records are skipped', () => {
  const rows = ['plain-string-row', 42, null, { role: 'user', text: 'the real prompt' }];
  expect(extractFromGeminiRows(rowsBody(rows))).toEqual({
    userPrompt: 'the real prompt',
    userPromptAddedAt: null,
  });
});

test('continues past a non-matching row to a later matching user row', () => {
  const rows = [
    { role: 'assistant', text: 'reply' },
    { role: 'user', text: 'second turn prompt' },
  ];
  expect(extractFromGeminiRows(rowsBody(rows))).toEqual({
    userPrompt: 'second turn prompt',
    userPromptAddedAt: null,
  });
});

test('user prompt is truncated to 2000 characters', () => {
  const rows = [{ role: 'user', text: 'x'.repeat(2500) }];
  const result = extractFromGeminiRows(rowsBody(rows));
  expect(result.userPrompt).toHaveLength(2000);
});

test('extractAssistantFromGeminiRows reads an assistant row', () => {
  const rows = [{ role: 'assistant', text: '  assistant says hi  ' }];
  expect(extractAssistantFromGeminiRows(rowsBody(rows))).toBe('assistant says hi');
});

test('extractAssistantFromGeminiRows truncates to 2000 characters', () => {
  const rows = [{ role: 'assistant', text: 'y'.repeat(2500) }];
  expect(extractAssistantFromGeminiRows(rowsBody(rows))).toHaveLength(2000);
});

test('extractAssistantFromGeminiRows returns null for invalid JSON', () => {
  expect(extractAssistantFromGeminiRows('not json [')).toBeNull();
});

test('extractAssistantFromGeminiRows returns null when not an array', () => {
  expect(extractAssistantFromGeminiRows(JSON.stringify({ rows: [] }))).toBeNull();
});

test('extractAssistantFromGeminiRows skips non-record and non-assistant rows', () => {
  const rows = ['plain', { role: 'user', text: 'u' }, { role: 'assistant', text: 'reply' }];
  expect(extractAssistantFromGeminiRows(rowsBody(rows))).toBe('reply');
});

test('extractAssistantFromGeminiRows returns null for an assistant row with empty text', () => {
  const rows = [{ role: 'assistant', text: '   ' }];
  expect(extractAssistantFromGeminiRows(rowsBody(rows))).toBeNull();
});

test('extractAssistantFromGeminiRows returns null for an assistant row with non-string text', () => {
  const rows = [{ role: 'assistant', text: 7 }];
  expect(extractAssistantFromGeminiRows(rowsBody(rows))).toBeNull();
});
