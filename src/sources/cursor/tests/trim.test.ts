import { requireDefined } from 'core/utils';
import { expect, test } from 'bun:test';

import { trimCursorRowValue } from 'sources/cursor';

function parse(value: string): Record<string, unknown> {
  return JSON.parse(value) as Record<string, unknown>;
}

test('trimCursorRowValue: bubbleId keeps conversational and metadata keys, drops the rest', () => {
  const value = JSON.stringify({
    _v: 3,
    type: 1,
    bubbleId: 'b1',
    text: 'hello there',
    richText: { doc: 'rich' },
    createdAt: '2026-05-21T00:00:00Z',
    capabilityType: 4,
    toolFormerData: { tool: 'Read', name: 'read_file' },
    thinking: { text: 'considering' },
    context: { fileSelections: [] },
    gitDiffs: [],
    codeBlocks: [],
  });
  const trimmed = parse(trimCursorRowValue('bubbleId:c1:b1', value));
  expect(trimmed.text).toBe('hello there');
  expect(trimmed.type).toBe(1);
  expect(trimmed.bubbleId).toBe('b1');
  expect(trimmed.richText).toEqual({ doc: 'rich' });
  expect(trimmed.createdAt).toBe('2026-05-21T00:00:00Z');
  expect(trimmed.capabilityType).toBe(4);
  expect(trimmed.toolFormerData).toEqual({ tool: 'Read', name: 'read_file' });
  expect(trimmed.thinking).toEqual({ text: 'considering' });
  expect(trimmed.context).toEqual({ fileSelections: [] });
  expect(trimmed.gitDiffs).toBeUndefined();
  expect(trimmed.codeBlocks).toBeUndefined();
});

test('trimCursorRowValue: agentKv user drops environment-wrapper content items', () => {
  const value = JSON.stringify({
    role: 'user',
    content: [
      null,
      { type: 'image' },
      { type: 'text', text: '<user_info>\nOS: darwin\n</user_info>' },
      { type: 'text', text: '<user_query>\nhow do I fix this\n</user_query>' },
    ],
  });
  const content = parse(trimCursorRowValue('agentKv:blob:abc', value)).content as unknown[];
  expect(content).toHaveLength(3);
  expect(JSON.stringify(content)).toContain('<user_query>');
  expect(JSON.stringify(content)).not.toContain('<user_info>');
});

test('trimCursorRowValue: agentKv user with string content is left intact', () => {
  const value = JSON.stringify({ role: 'user', content: 'plain prompt' });
  expect(parse(trimCursorRowValue('agentKv:blob:u', value)).content).toBe('plain prompt');
});

test('trimCursorRowValue: agentKv assistant drops reasoning and trims tool-call args', () => {
  const value = JSON.stringify({
    role: 'assistant',
    content: [
      { type: 'redacted-reasoning', data: 'opaque-blob' },
      { type: 'reasoning', text: 'internal' },
      { type: 'text', text: 'Here is the answer.' },
      { type: 'tool-call', toolName: 'Read', args: { path: '/a/b.ts', body: 'y'.repeat(2000) } },
      null,
      { type: 'tool-call', args: null },
    ],
  });
  const content = parse(trimCursorRowValue('agentKv:blob:def', value)).content as Array<
    Record<string, unknown>
  >;
  expect(content).toHaveLength(4);
  expect(requireDefined(content[0]).type).toBe('text');
  expect(requireDefined(content[1]).type).toBe('tool-call');
  const args = requireDefined(content[1]).args as Record<string, unknown>;
  expect(args.path).toBe('/a/b.ts');
  expect(args.body).toBe('<trimmed>');
  expect(content[2]).toBeNull();
  expect(requireDefined(content[3]).args).toBeNull();
});

test('trimCursorRowValue: assistant with non-array content is left intact', () => {
  const value = JSON.stringify({ role: 'assistant', content: 'plain reply' });
  expect(parse(trimCursorRowValue('agentKv:blob:a', value)).content).toBe('plain reply');
});

test('trimCursorRowValue: leaves composerData, tool blobs, and odd values untouched', () => {
  const composer = JSON.stringify({ composerId: 'x', name: 'thread', conversationState: '~b64' });
  expect(trimCursorRowValue('composerData:x', composer)).toBe(composer);

  const toolBlob = JSON.stringify({ role: 'tool', content: [] });
  expect(trimCursorRowValue('agentKv:blob:t', toolBlob)).toBe(toolBlob);

  expect(trimCursorRowValue('bubbleId:c:b', 'not valid json')).toBe('not valid json');
  expect(trimCursorRowValue('bubbleId:c:b', JSON.stringify('bare string'))).toBe(
    JSON.stringify('bare string'),
  );
});

test('trimCursorRowValue: bubbleId keeps the per-turn context-size gauge', () => {
  const value = JSON.stringify({
    _v: 3,
    type: 1,
    bubbleId: 'b1',
    text: 'do the thing',
    contextWindowStatusAtCreation: { tokensUsed: 114724, tokenLimit: 200000 },
    gitDiffs: [],
  });
  const trimmed = parse(trimCursorRowValue('bubbleId:c1:b1', value));
  expect(trimmed.contextWindowStatusAtCreation).toEqual({
    tokensUsed: 114724,
    tokenLimit: 200000,
  });
  expect(trimmed.gitDiffs).toBeUndefined(); // non-keep keys still dropped
});
