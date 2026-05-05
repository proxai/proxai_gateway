import { expect, test } from 'bun:test';
import { homedir } from 'node:os';

import {
  bufferDbPath,
  configDir,
  configFilePath,
  consentSentinelPath,
  expandHome,
  logDir,
  pausedSentinelPath,
} from 'core/io/fs';

test('configDir returns ~/.proxai on macOS / Linux', () => {
  if (process.platform === 'darwin' || process.platform === 'linux') {
    expect(configDir()).toBe(`${homedir()}/.proxai`);
  }
});

test('logDir is platform-appropriate', () => {
  const dir = logDir();
  expect(dir).toContain('proxai-gateway');
});

test('derived paths live under configDir', () => {
  const root = configDir();
  expect(bufferDbPath().startsWith(root)).toBe(true);
  expect(configFilePath().startsWith(root)).toBe(true);
  expect(pausedSentinelPath().startsWith(root)).toBe(true);
  expect(consentSentinelPath().startsWith(root)).toBe(true);
});

test('expandHome expands leading ~/', () => {
  expect(expandHome('~/foo/bar')).toBe(`${homedir()}/foo/bar`);
  expect(expandHome('~')).toBe(homedir());
  expect(expandHome('/abs/path')).toBe('/abs/path');
  expect(expandHome('relative/path')).toBe('relative/path');
});
