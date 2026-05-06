import { expect, test } from 'bun:test';
import { homedir } from 'node:os';

import {
  authFailedSentinelPath,
  bufferDbPath,
  bufferFullSentinelPath,
  configDir,
  configFilePath,
  consentSentinelPath,
  controlSocketPath,
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
  expect(authFailedSentinelPath().startsWith(root)).toBe(true);
  expect(bufferFullSentinelPath().startsWith(root)).toBe(true);
  expect(authFailedSentinelPath()).toContain('AUTH_FAILED');
  expect(bufferFullSentinelPath()).toContain('BUFFER_FULL');
});

test('expandHome expands leading ~/', () => {
  expect(expandHome('~/foo/bar')).toBe(`${homedir()}/foo/bar`);
  expect(expandHome('~')).toBe(homedir());
  expect(expandHome('/abs/path')).toBe('/abs/path');
  expect(expandHome('relative/path')).toBe('relative/path');
});

function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  }
}

test('configDir on linux uses ~/.proxai', () => {
  withPlatform('linux', () => {
    expect(configDir()).toBe(`${homedir()}/.proxai`);
  });
});

test('configDir on win32 uses LOCALAPPDATA when set', () => {
  const original = process.env['LOCALAPPDATA'];
  process.env['LOCALAPPDATA'] = 'C:\\AppData\\Local';
  withPlatform('win32', () => {
    expect(configDir()).toContain('proxai-gateway');
  });
  if (original === undefined) delete process.env['LOCALAPPDATA'];
  else process.env['LOCALAPPDATA'] = original;
});

test('configDir on win32 uses fallback when LOCALAPPDATA absent', () => {
  const original = process.env['LOCALAPPDATA'];
  delete process.env['LOCALAPPDATA'];
  withPlatform('win32', () => {
    expect(configDir()).toContain('AppData');
  });
  if (original === undefined) delete process.env['LOCALAPPDATA'];
  else process.env['LOCALAPPDATA'] = original;
});

test('configDir throws on unsupported platform', () => {
  withPlatform('aix' as NodeJS.Platform, () => {
    expect(() => configDir()).toThrow('unsupported platform');
  });
});

test('logDir on linux uses ~/.local/state', () => {
  withPlatform('linux', () => {
    expect(logDir()).toContain('.local/state/proxai-gateway');
  });
});

test('logDir on win32 uses LOCALAPPDATA Logs', () => {
  const original = process.env['LOCALAPPDATA'];
  process.env['LOCALAPPDATA'] = 'C:\\AppData\\Local';
  withPlatform('win32', () => {
    expect(logDir()).toContain('Logs');
  });
  if (original === undefined) delete process.env['LOCALAPPDATA'];
  else process.env['LOCALAPPDATA'] = original;
});

test('logDir on win32 uses fallback when LOCALAPPDATA absent', () => {
  const original = process.env['LOCALAPPDATA'];
  delete process.env['LOCALAPPDATA'];
  withPlatform('win32', () => {
    expect(logDir()).toContain('proxai-gateway');
  });
  if (original === undefined) delete process.env['LOCALAPPDATA'];
  else process.env['LOCALAPPDATA'] = original;
});

test('logDir throws on unsupported platform', () => {
  withPlatform('aix' as NodeJS.Platform, () => {
    expect(() => logDir()).toThrow('unsupported platform');
  });
});

test('controlSocketPath returns posix socket on darwin', () => {
  withPlatform('darwin', () => {
    expect(controlSocketPath()).toMatch(/control\.sock$/);
  });
});

test('controlSocketPath returns posix socket on linux', () => {
  withPlatform('linux', () => {
    expect(controlSocketPath()).toMatch(/control\.sock$/);
  });
});

test('controlSocketPath returns named pipe on win32', () => {
  withPlatform('win32', () => {
    expect(controlSocketPath().startsWith('\\\\.\\pipe\\')).toBe(true);
  });
});

test('controlSocketPath throws on unsupported platform', () => {
  withPlatform('aix' as NodeJS.Platform, () => {
    expect(() => controlSocketPath()).toThrow('unsupported platform');
  });
});
