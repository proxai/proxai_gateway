import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';

import { resolveNestBaseUrl } from 'services/config/config.constants.ts';

const mockDir = join(tmpdir(), `DEV_MODE_ROOT_TEST_${Math.random().toString(36).slice(2)}`);
const mockSentinelPath = join(mockDir, 'DEV_MODE');

test('defaults to the production Railway URL when sentinel is absent', () => {
  if (existsSync(mockSentinelPath)) {
    unlinkSync(mockSentinelPath);
  }
  expect(resolveNestBaseUrl(mockSentinelPath)).toBe('https://proxainest-production.up.railway.app');
});

test('uses localhost:3001 when sentinel is present', () => {
  mkdirSync(mockDir, { recursive: true });
  writeFileSync(mockSentinelPath, 'ENABLED');
  try {
    expect(resolveNestBaseUrl(mockSentinelPath)).toBe('http://localhost:3001');
  } finally {
    if (existsSync(mockSentinelPath)) {
      unlinkSync(mockSentinelPath);
    }
  }
});
