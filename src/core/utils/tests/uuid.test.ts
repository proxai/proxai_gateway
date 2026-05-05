import { test, expect } from 'bun:test';

import { generateUuidV7, isUuidV7 } from 'core/utils';

test('generates valid UUIDv7', () => {
  const id = generateUuidV7();
  expect(isUuidV7(id)).toBe(true);
});

test('rejects v4 / random / invalid strings', () => {
  expect(isUuidV7('00000000-0000-4000-8000-000000000000')).toBe(false);
  expect(isUuidV7('not-a-uuid')).toBe(false);
  expect(isUuidV7('')).toBe(false);
});

test('successive UUIDv7s sort lexicographically (timestamp prefix)', async () => {
  const a = generateUuidV7();
  await Bun.sleep(2);
  const b = generateUuidV7();
  expect(a < b).toBe(true);
});
