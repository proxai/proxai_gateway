import { expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { expandHome, legacyRootDir } from 'core/io/fs';

test('legacyRootDir returns the root without profile segment', () => {
  if (process.platform === 'darwin' || process.platform === 'linux') {
    expect(legacyRootDir()).toBe(join(homedir(), '.proxai', 'proxai-gateway'));
  }
});

test('expandHome expands leading ~/', () => {
  expect(expandHome('~/foo/bar')).toBe(join(homedir(), 'foo', 'bar'));
  expect(expandHome('~')).toBe(homedir());
  expect(expandHome('/abs/path')).toBe('/abs/path');
  expect(expandHome('relative/path')).toBe('relative/path');
});
