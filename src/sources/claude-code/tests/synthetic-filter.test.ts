import { expect, test } from 'bun:test';

import { isDialogueRecord, isUsageBearingAssistantRecord } from 'sources/claude-code';

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

test('isUsageBearingAssistantRecord: keeps tool_use assistant records carrying usage', () => {
  expect(
    isUsageBearingAssistantRecord({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 't', name: 'Read' }],
        usage: { input_tokens: 3, output_tokens: 4 },
      },
    }),
  ).toBe(true);
});

test('isUsageBearingAssistantRecord: drops assistant records with no usage block', () => {
  expect(
    isUsageBearingAssistantRecord({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't', name: 'Read' }] },
    }),
  ).toBe(false);
});

test('isUsageBearingAssistantRecord: drops synthetic, api-error, and meta records even with usage', () => {
  expect(
    isUsageBearingAssistantRecord({
      type: 'assistant',
      message: { model: '<synthetic>', usage: { input_tokens: 1 } },
    }),
  ).toBe(false);
  expect(
    isUsageBearingAssistantRecord({
      type: 'assistant',
      isApiErrorMessage: true,
      message: { usage: { input_tokens: 1 } },
    }),
  ).toBe(false);
  expect(
    isUsageBearingAssistantRecord({
      type: 'assistant',
      isMeta: true,
      message: { usage: { input_tokens: 1 } },
    }),
  ).toBe(false);
});

test('isUsageBearingAssistantRecord: drops non-assistant and non-object inputs', () => {
  expect(isUsageBearingAssistantRecord({ type: 'user', message: { usage: {} } })).toBe(false);
  expect(isUsageBearingAssistantRecord(null)).toBe(false);
  expect(isUsageBearingAssistantRecord('x')).toBe(false);
});
