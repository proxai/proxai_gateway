import { expect, test } from 'bun:test';

import { classifyCodexPlatform, codexPlatformFromSessionMeta } from 'sources/codex';

test('classifyCodexPlatform maps vscode source to codex-desktop', () => {
  expect(classifyCodexPlatform('vscode', null)).toBe('codex-desktop');
});

test('classifyCodexPlatform maps Codex Desktop originator to codex-desktop', () => {
  expect(classifyCodexPlatform(null, 'Codex Desktop')).toBe('codex-desktop');
});

test('classifyCodexPlatform maps cli source to codex-cli', () => {
  expect(classifyCodexPlatform('cli', null)).toBe('codex-cli');
});

test('classifyCodexPlatform maps codex-tui originator to codex-cli', () => {
  expect(classifyCodexPlatform(null, 'codex-tui')).toBe('codex-cli');
});

test('classifyCodexPlatform falls back to codex-cli for unknown / missing', () => {
  expect(classifyCodexPlatform(null, null)).toBe('codex-cli');
  expect(classifyCodexPlatform('something-else', 'nope')).toBe('codex-cli');
});

test('codexPlatformFromSessionMeta reads desktop from payload.source', () => {
  const line = JSON.stringify({ type: 'session_meta', payload: { source: 'vscode' } });
  expect(codexPlatformFromSessionMeta(line)).toBe('codex-desktop');
});

test('codexPlatformFromSessionMeta reads desktop from payload.originator', () => {
  const line = JSON.stringify({
    type: 'session_meta',
    payload: { source: 'cli', originator: 'Codex Desktop' },
  });
  expect(codexPlatformFromSessionMeta(line)).toBe('codex-desktop');
});

test('codexPlatformFromSessionMeta reads cli from payload.source', () => {
  const line = JSON.stringify({
    type: 'session_meta',
    payload: { source: 'cli', originator: 'codex-tui' },
  });
  expect(codexPlatformFromSessionMeta(line)).toBe('codex-cli');
});

test('codexPlatformFromSessionMeta returns null for non-session_meta lines', () => {
  expect(codexPlatformFromSessionMeta(JSON.stringify({ type: 'response_item' }))).toBeNull();
});

test('codexPlatformFromSessionMeta returns null when payload lacks both signals', () => {
  expect(
    codexPlatformFromSessionMeta(JSON.stringify({ type: 'session_meta', payload: {} })),
  ).toBeNull();
});

test('codexPlatformFromSessionMeta returns null for malformed JSON', () => {
  expect(codexPlatformFromSessionMeta('{not json')).toBeNull();
});

test('codexPlatformFromSessionMeta returns null for a non-object payload', () => {
  expect(
    codexPlatformFromSessionMeta(JSON.stringify({ type: 'session_meta', payload: 'x' })),
  ).toBeNull();
});

test('codexPlatformFromSessionMeta returns null for a non-object top level', () => {
  expect(codexPlatformFromSessionMeta('42')).toBeNull();
});
