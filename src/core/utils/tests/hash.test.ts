import { test, expect } from 'bun:test';

import { sha256Hex } from 'core/utils';

test('sha256 of empty string', () => {
  expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('sha256 of "abc"', () => {
  expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('sha256 hex digest is 64 hex chars', () => {
  const out = sha256Hex('/Users/alice/.claude/projects/example/session-uuid.jsonl');
  expect(out).toHaveLength(64);
  expect(out).toMatch(/^[0-9a-f]{64}$/);
});

test('sha256 accepts Uint8Array input', () => {
  const bytes = new TextEncoder().encode('abc');
  expect(sha256Hex(bytes)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
