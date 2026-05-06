import { expect, test } from 'bun:test';

import { deriveHostId } from 'core/system';

test('deriveHostId is deterministic', () => {
  expect(deriveHostId('uuid-A', 'user-1')).toBe(deriveHostId('uuid-A', 'user-1'));
});

test('deriveHostId returns 64-char lowercase hex', () => {
  const id = deriveHostId('uuid-A', 'user-1');
  expect(id).toMatch(/^[0-9a-f]{64}$/);
});

test('deriveHostId differs when machine UUID differs', () => {
  expect(deriveHostId('uuid-A', 'user-1')).not.toBe(deriveHostId('uuid-B', 'user-1'));
});

test('deriveHostId differs when user id differs', () => {
  expect(deriveHostId('uuid-A', 'user-1')).not.toBe(deriveHostId('uuid-A', 'user-2'));
});

test('deriveHostId is whitespace-insensitive on inputs', () => {
  expect(deriveHostId('  uuid-A  ', '  user-1  ')).toBe(deriveHostId('uuid-A', 'user-1'));
  expect(deriveHostId('\tuuid-A\n', 'user-1')).toBe(deriveHostId('uuid-A', 'user-1'));
});

test('deriveHostId binds machine and user (no trivial swap collision)', () => {
  // sha256(A:B) != sha256(B:A) — avoids confusion if someone passes args reversed.
  expect(deriveHostId('A', 'B')).not.toBe(deriveHostId('B', 'A'));
});
