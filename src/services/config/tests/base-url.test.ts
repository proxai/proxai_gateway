import { expect, test, mock } from 'bun:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';

const mockSentinelPath = join(tmpdir(), `DEV_MODE_TEST_${Math.random().toString(36).slice(2)}`);

mock.module('core/io/fs', () => {
  const actual = import.meta.require('core/io/fs');
  return {
    ...actual,
    devModeSentinelPath: () => mockSentinelPath,
  };
});

import { resolveNestBaseUrl } from 'services/config';

test('defaults to the production Railway URL when sentinel is absent', () => {
  if (existsSync(mockSentinelPath)) {
    unlinkSync(mockSentinelPath);
  }
  expect(resolveNestBaseUrl()).toBe('https://proxainest-production.up.railway.app');
});

test('uses localhost:3001 when sentinel is present', () => {
  writeFileSync(mockSentinelPath, 'ENABLED');
  try {
    expect(resolveNestBaseUrl()).toBe('http://localhost:3001');
  } finally {
    if (existsSync(mockSentinelPath)) {
      unlinkSync(mockSentinelPath);
    }
  }
});
