import { requireDefined } from 'core/utils';
import { expect, test } from 'bun:test';

import {
  trimGeminiCliRecord,
  trimGeminiThought,
  trimGeminiToolCall,
  trimGeminiToolCallArgs,
} from 'sources/gemini-cli';

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
  expect(requireDefined(toolCalls[0]).result).toBeUndefined();
  expect(requireDefined(toolCalls[0]).resultDisplay).toBeUndefined();
  expect(requireDefined(toolCalls[0]).renderOutputAsMarkdown).toBeUndefined();
  expect(requireDefined(toolCalls[0]).name).toBe('run_shell_command');

  const args = requireDefined(toolCalls[0]).args as Record<string, unknown>;
  expect(args.command).toBe('ls');
  expect(args.new_string).toBe('<trimmed>');

  const thoughts = trimmed.thoughts as Array<Record<string, unknown>>;
  expect(requireDefined(thoughts[0]).subject).toBe('plan');
  expect(requireDefined(thoughts[0]).description).toBeUndefined();
});

test('trimGeminiCliRecord: leaves non-gemini records untouched', () => {
  const user = { type: 'user', content: [{ text: 'hi' }] };
  expect(trimGeminiCliRecord(user)).toBe(user);
  expect(trimGeminiCliRecord(null)).toBeNull();
  expect(trimGeminiCliRecord('not an object')).toBe('not an object');
  expect(trimGeminiCliRecord([])).toEqual([]);
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

test('trimGeminiToolCall and trimGeminiThought: handle non-object inputs and arrays', () => {
  expect(trimGeminiToolCall(null)).toBeNull();
  expect(trimGeminiToolCall('string')).toBe('string');
  expect(trimGeminiToolCall(123)).toBe(123);
  expect(trimGeminiToolCall([])).toEqual([]);

  expect(trimGeminiThought(null)).toBeNull();
  expect(trimGeminiThought('string')).toBe('string');
  expect(trimGeminiThought(123)).toBe(123);
  expect(trimGeminiThought([])).toEqual([]);
});

test('trimGeminiToolCallArgs: handles null, non-object inputs, and arrays', () => {
  expect(trimGeminiToolCallArgs(null)).toBeNull();
  expect(trimGeminiToolCallArgs('string')).toBe('string');
  expect(trimGeminiToolCallArgs(123)).toBe(123);
  expect(trimGeminiToolCallArgs([])).toEqual([]);
});

test('trimGeminiToolCallArgs: trims string args over max length and keeps others', () => {
  const input = {
    shortStr: 'hello',
    longStr: 'a'.repeat(600),
    num: 100,
    bool: true,
  };
  const result = trimGeminiToolCallArgs(input) as Record<string, unknown>;
  expect(result.shortStr).toBe('hello');
  expect(result.longStr).toBe('<trimmed>');
  expect(result.num).toBe(100);
  expect(result.bool).toBe(true);
});

test('trimGeminiToolCall: handles edge-case branches', () => {
  const callWithoutArgs = {
    id: 'tc1',
    name: 'test_func',
  };
  const result1 = trimGeminiToolCall(callWithoutArgs) as Record<string, unknown>;
  expect(result1.id).toBe('tc1');
  expect(result1.name).toBe('test_func');
  expect(result1.args).toBeUndefined();

  const callWithNonObjectArgs = {
    id: 'tc2',
    name: 'test_func_2',
    args: 'not_an_object',
  };
  const result2 = trimGeminiToolCall(callWithNonObjectArgs) as Record<string, unknown>;
  expect(result2.args).toBe('not_an_object');

  const callWithArrayArgs = {
    id: 'tc3',
    name: 'test_func_3',
    args: [1, 2, 3],
  };
  const result3 = trimGeminiToolCall(callWithArrayArgs) as Record<string, unknown>;
  expect(result3.args).toEqual([1, 2, 3]);

  const callWithNullArgs = {
    id: 'tc4',
    name: 'test_func_4',
    args: null,
  };
  const result4 = trimGeminiToolCall(callWithNullArgs) as Record<string, unknown>;
  expect(result4.args).toBeNull();
});

test('trimGeminiThought: handles edge-case branches', () => {
  const thoughtWithoutSubjectOrTimestamp = {
    description: 'just desc',
  };
  const result1 = trimGeminiThought(thoughtWithoutSubjectOrTimestamp) as Record<string, unknown>;
  expect(result1.subject).toBeUndefined();
  expect(result1.timestamp).toBeUndefined();
  expect(result1.description).toBeUndefined();

  const thoughtWithSubjectOnly = {
    subject: 'subj',
  };
  const result2 = trimGeminiThought(thoughtWithSubjectOnly) as Record<string, unknown>;
  expect(result2.subject).toBe('subj');
  expect(result2.timestamp).toBeUndefined();

  const thoughtWithTimestampOnly = {
    timestamp: 'time',
  };
  const result3 = trimGeminiThought(thoughtWithTimestampOnly) as Record<string, unknown>;
  expect(result3.subject).toBeUndefined();
  expect(result3.timestamp).toBe('time');
});
