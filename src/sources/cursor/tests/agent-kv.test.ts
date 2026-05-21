import { expect, test } from 'bun:test';

import { isAgentKvConversationBlob } from 'sources/cursor';

test('isAgentKvConversationBlob: keeps user and assistant role blobs', () => {
  expect(isAgentKvConversationBlob(JSON.stringify({ role: 'user', content: 'hi' }))).toBe(true);
  expect(isAgentKvConversationBlob(JSON.stringify({ role: 'assistant', content: [] }))).toBe(true);
});

test('isAgentKvConversationBlob: drops tool, system, role-less, and non-object blobs', () => {
  expect(isAgentKvConversationBlob(JSON.stringify({ role: 'tool', content: [] }))).toBe(false);
  expect(isAgentKvConversationBlob(JSON.stringify({ role: 'system', content: 'x' }))).toBe(false);
  expect(isAgentKvConversationBlob(JSON.stringify({ content: 'no role here' }))).toBe(false);
  expect(isAgentKvConversationBlob(JSON.stringify('a bare string'))).toBe(false);
});

test('isAgentKvConversationBlob: drops non-JSON protobuf blobs', () => {
  expect(isAgentKvConversationBlob('\x0a\x20 not json at all')).toBe(false);
});
