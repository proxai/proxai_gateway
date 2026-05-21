import { expect, test } from 'bun:test';

import { isDialogueRecord } from 'sources/claude-code';

test('isDialogueRecord: drops isMeta user records', () => {
  expect(
    isDialogueRecord({ type: 'user', isMeta: true, message: { content: 'Continue from before.' } }),
  ).toBe(false);
});

test('isDialogueRecord: drops synthetic shell and command wrapper text', () => {
  const prefixes = [
    '<bash-input>',
    '<local-command-stdout>',
    '<local-command-stderr>',
    '<command-name>',
    '<system-reminder>',
    '<local-command-caveat>',
  ];
  for (const prefix of prefixes) {
    expect(isDialogueRecord({ type: 'user', message: { content: `${prefix} payload` } })).toBe(
      false,
    );
  }
});

test('isDialogueRecord: keeps a genuine user prompt', () => {
  expect(isDialogueRecord({ type: 'user', message: { content: 'please fix the bug' } })).toBe(true);
});

test('isDialogueRecord: drops synthetic-model and api-error assistant records', () => {
  expect(
    isDialogueRecord({
      type: 'assistant',
      message: {
        model: '<synthetic>',
        content: [{ type: 'text', text: 'No response requested.' }],
      },
    }),
  ).toBe(false);
  expect(
    isDialogueRecord({
      type: 'assistant',
      isApiErrorMessage: true,
      message: { content: [{ type: 'text', text: 'API error occurred' }] },
    }),
  ).toBe(false);
});

test('isDialogueRecord: keeps assistant text even with non-text items in the array', () => {
  expect(
    isDialogueRecord({
      type: 'assistant',
      message: {
        model: 'claude-opus-4-7',
        content: [
          { type: 'thinking', thinking: '' },
          { type: 'text', text: 'Here is the real answer.' },
        ],
      },
    }),
  ).toBe(true);
});
