import { expect, test } from 'bun:test';

import { trimGeminiCliRecord } from 'sources/gemini-cli';

test('trimGeminiCliRecord: drops tool result/resultDisplay and trims heavy args', () => {
  const record = {
    id: 'g1',
    timestamp: '2026-05-01T00:00:00Z',
    type: 'gemini',
    content: 'reply text',
    model: 'gemini-3',
    tokens: { total: 10 },
    thoughts: [{ subject: 'plan', description: 'a long internal description', timestamp: 't' }],
    toolCalls: [
      {
        id: 'tc1',
        name: 'run_shell_command',
        displayName: 'Shell',
        description: 'run a command',
        status: 'success',
        timestamp: 't',
        renderOutputAsMarkdown: true,
        args: { command: 'ls', new_string: 'x'.repeat(2000) },
        result: [{ functionResponse: { output: 'huge output' } }],
        resultDisplay: [[{ text: 'a' }]],
      },
    ],
  };
  const trimmed = trimGeminiCliRecord(record) as Record<string, unknown>;
  expect(trimmed.content).toBe('reply text');
  expect(trimmed.tokens).toEqual({ total: 10 });

  const toolCalls = trimmed.toolCalls as Array<Record<string, unknown>>;
  expect(toolCalls[0]!.result).toBeUndefined();
  expect(toolCalls[0]!.resultDisplay).toBeUndefined();
  expect(toolCalls[0]!.renderOutputAsMarkdown).toBeUndefined();
  expect(toolCalls[0]!.name).toBe('run_shell_command');

  const args = toolCalls[0]!.args as Record<string, unknown>;
  expect(args.command).toBe('ls');
  expect(args.new_string).toBe('<trimmed>');

  const thoughts = trimmed.thoughts as Array<Record<string, unknown>>;
  expect(thoughts[0]!.subject).toBe('plan');
  expect(thoughts[0]!.description).toBeUndefined();
});

test('trimGeminiCliRecord: leaves non-gemini records unchanged', () => {
  const user = { type: 'user', content: [{ text: 'hi' }] };
  expect(trimGeminiCliRecord(user)).toBe(user);
  expect(trimGeminiCliRecord(null)).toBeNull();
  expect(trimGeminiCliRecord('not an object')).toBe('not an object');
});

test('trimGeminiCliRecord: handles gemini records without toolCalls or thoughts', () => {
  const trimmed = trimGeminiCliRecord({ type: 'gemini', content: 'hello' }) as Record<
    string,
    unknown
  >;
  expect(trimmed.content).toBe('hello');
});

test('trimGeminiCliRecord: tolerates null and arg-less entries', () => {
  const trimmed = trimGeminiCliRecord({
    type: 'gemini',
    toolCalls: [null, { name: 'noargs' }, { name: 'nullargs', args: null }],
    thoughts: [null, { subject: 's' }],
  }) as Record<string, unknown>;

  const toolCalls = trimmed.toolCalls as unknown[];
  expect(toolCalls[0]).toBeNull();
  expect((toolCalls[1] as Record<string, unknown>).name).toBe('noargs');
  expect((toolCalls[2] as Record<string, unknown>).args).toBeNull();

  const thoughts = trimmed.thoughts as unknown[];
  expect(thoughts[0]).toBeNull();
  expect((thoughts[1] as Record<string, unknown>).subject).toBe('s');
});
