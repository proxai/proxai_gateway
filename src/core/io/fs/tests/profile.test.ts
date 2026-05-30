import { expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';

import { buildProfileContext, profileLogDirRoot, profileRootDir } from 'core/io/fs/profile.ts';

function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  }
}

test('profileRootDir matches existing configDir output on current platform', () => {
  if (process.platform === 'darwin' || process.platform === 'linux') {
    expect(profileRootDir()).toBe(join(homedir(), '.proxai', 'proxai-gateway'));
  }
  if (process.platform === 'win32') {
    const localAppData = process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local');
    expect(profileRootDir()).toBe(join(localAppData, 'proxai', 'proxai-gateway'));
  }
});

test('profileRootDir on linux returns ~/.proxai/proxai-gateway', () => {
  withPlatform('linux', () => {
    expect(profileRootDir()).toBe(join(homedir(), '.proxai', 'proxai-gateway'));
  });
});

test('profileRootDir on darwin returns ~/.proxai/proxai-gateway', () => {
  withPlatform('darwin', () => {
    expect(profileRootDir()).toBe(join(homedir(), '.proxai', 'proxai-gateway'));
  });
});

test('profileRootDir on win32 uses LOCALAPPDATA when set', () => {
  const original = process.env['LOCALAPPDATA'];
  process.env['LOCALAPPDATA'] = join('C:', 'AppData', 'Local');
  withPlatform('win32', () => {
    const dir = profileRootDir();
    expect(dir).toContain('proxai');
    expect(dir).toContain('proxai-gateway');
    expect(dir.startsWith(join('C:', 'AppData', 'Local'))).toBe(true);
  });
  if (original === undefined) delete process.env['LOCALAPPDATA'];
  else process.env['LOCALAPPDATA'] = original;
});

test('profileRootDir on win32 uses fallback when LOCALAPPDATA absent', () => {
  const original = process.env['LOCALAPPDATA'];
  delete process.env['LOCALAPPDATA'];
  withPlatform('win32', () => {
    const dir = profileRootDir();
    expect(dir).toContain('AppData');
    expect(dir).toContain('proxai');
    expect(dir).toContain('proxai-gateway');
  });
  if (original === undefined) delete process.env['LOCALAPPDATA'];
  else process.env['LOCALAPPDATA'] = original;
});

test('profileRootDir throws on unsupported platform', () => {
  withPlatform('aix' as NodeJS.Platform, () => {
    expect(() => profileRootDir()).toThrow('unsupported platform');
  });
});

test('profileLogDirRoot on darwin uses Library/Logs', () => {
  withPlatform('darwin', () => {
    expect(profileLogDirRoot()).toBe(
      join(homedir(), 'Library', 'Logs', 'proxai', 'proxai-gateway'),
    );
  });
});

test('profileLogDirRoot on linux uses ~/.local/state', () => {
  withPlatform('linux', () => {
    expect(profileLogDirRoot()).toContain(
      join('.local', 'state', 'proxai', 'proxai-gateway', 'log'),
    );
  });
});

test('profileLogDirRoot on win32 uses LOCALAPPDATA Logs', () => {
  const original = process.env['LOCALAPPDATA'];
  process.env['LOCALAPPDATA'] = join('C:', 'AppData', 'Local');
  withPlatform('win32', () => {
    const dir = profileLogDirRoot();
    expect(dir).toContain('Logs');
    expect(dir).toContain('proxai');
    expect(dir).toContain('proxai-gateway');
  });
  if (original === undefined) delete process.env['LOCALAPPDATA'];
  else process.env['LOCALAPPDATA'] = original;
});

test('profileLogDirRoot on win32 uses fallback when LOCALAPPDATA absent', () => {
  const original = process.env['LOCALAPPDATA'];
  delete process.env['LOCALAPPDATA'];
  withPlatform('win32', () => {
    const dir = profileLogDirRoot();
    expect(dir).toContain('proxai');
    expect(dir).toContain('proxai-gateway');
  });
  if (original === undefined) delete process.env['LOCALAPPDATA'];
  else process.env['LOCALAPPDATA'] = original;
});

test('profileLogDirRoot throws on unsupported platform', () => {
  withPlatform('aix' as NodeJS.Platform, () => {
    expect(() => profileLogDirRoot()).toThrow('unsupported platform');
  });
});

test('buildProfileContext prod: name and isDev', () => {
  const ctx = buildProfileContext('prod');
  expect(ctx.name).toBe('prod');
  expect(ctx.isDev).toBe(false);
});

test('buildProfileContext dev: name and isDev', () => {
  const ctx = buildProfileContext('dev');
  expect(ctx.name).toBe('dev');
  expect(ctx.isDev).toBe(true);
});

test('buildProfileContext prod: configDir ends with sep+prod', () => {
  const ctx = buildProfileContext('prod');
  expect(ctx.configDir.endsWith(`${sep}prod`)).toBe(true);
});

test('buildProfileContext dev: configDir ends with sep+dev', () => {
  const ctx = buildProfileContext('dev');
  expect(ctx.configDir.endsWith(`${sep}dev`)).toBe(true);
});

test('buildProfileContext prod: configFilePath ends with sep+prod+sep+config.toml', () => {
  const ctx = buildProfileContext('prod');
  expect(ctx.configFilePath.endsWith(join('prod', 'config.toml'))).toBe(true);
});

test('buildProfileContext dev: configFilePath ends with sep+dev+sep+config.toml', () => {
  const ctx = buildProfileContext('dev');
  expect(ctx.configFilePath.endsWith(join('dev', 'config.toml'))).toBe(true);
});

test('buildProfileContext prod: bufferDbPath ends with sep+prod+sep+buffer.db', () => {
  const ctx = buildProfileContext('prod');
  expect(ctx.bufferDbPath.endsWith(join('prod', 'buffer.db'))).toBe(true);
});

test('buildProfileContext dev: bufferDbPath ends with sep+dev+sep+buffer.db', () => {
  const ctx = buildProfileContext('dev');
  expect(ctx.bufferDbPath.endsWith(join('dev', 'buffer.db'))).toBe(true);
});

test('buildProfileContext prod: sentinel paths end with correct names under prod', () => {
  const ctx = buildProfileContext('prod');
  expect(ctx.sentinels.authFailed.endsWith(join('prod', 'AUTH_FAILED'))).toBe(true);
  expect(ctx.sentinels.bufferFull.endsWith(join('prod', 'BUFFER_FULL'))).toBe(true);
  expect(ctx.sentinels.sessionStopped.endsWith(join('prod', 'SESSION_STOPPED'))).toBe(true);
  expect(ctx.sentinels.consent.endsWith(join('prod', 'CONSENT_ACCEPTED'))).toBe(true);
  expect(ctx.sentinels.updateAvailable.endsWith(join('prod', 'UPDATE_AVAILABLE'))).toBe(true);
});

test('buildProfileContext dev: sentinel paths end with correct names under dev', () => {
  const ctx = buildProfileContext('dev');
  expect(ctx.sentinels.authFailed.endsWith(join('dev', 'AUTH_FAILED'))).toBe(true);
  expect(ctx.sentinels.bufferFull.endsWith(join('dev', 'BUFFER_FULL'))).toBe(true);
  expect(ctx.sentinels.sessionStopped.endsWith(join('dev', 'SESSION_STOPPED'))).toBe(true);
  expect(ctx.sentinels.consent.endsWith(join('dev', 'CONSENT_ACCEPTED'))).toBe(true);
  expect(ctx.sentinels.updateAvailable.endsWith(join('dev', 'UPDATE_AVAILABLE'))).toBe(true);
});

test('buildProfileContext prod: defaultNestBaseUrl is the prod URL', () => {
  const ctx = buildProfileContext('prod');
  expect(ctx.defaultNestBaseUrl).toBe('https://proxainest-production.up.railway.app');
});

test('buildProfileContext dev: defaultNestBaseUrl is the dev URL', () => {
  const ctx = buildProfileContext('dev');
  expect(ctx.defaultNestBaseUrl).toBe('http://localhost:3001');
});

test('buildProfileContext prod: logDir ends with sep+prod', () => {
  const ctx = buildProfileContext('prod');
  expect(ctx.logDir.endsWith(`${sep}prod`)).toBe(true);
});

test('buildProfileContext dev: logDir ends with sep+dev', () => {
  const ctx = buildProfileContext('dev');
  expect(ctx.logDir.endsWith(`${sep}dev`)).toBe(true);
});

test('prod and dev logDir differ', () => {
  const prod = buildProfileContext('prod');
  const dev = buildProfileContext('dev');
  expect(prod.logDir).not.toBe(dev.logDir);
});

test('buildProfileContext controlSocketPath on posix ends with sep+prod+sep+control.sock', () => {
  if (process.platform === 'darwin' || process.platform === 'linux') {
    const ctx = buildProfileContext('prod');
    expect(ctx.controlSocketPath.endsWith(join('prod', 'control.sock'))).toBe(true);
  }
});

test('buildProfileContext controlSocketPath on posix is profile-scoped for dev', () => {
  if (process.platform === 'darwin' || process.platform === 'linux') {
    const ctx = buildProfileContext('dev');
    expect(ctx.controlSocketPath.endsWith(join('dev', 'control.sock'))).toBe(true);
  }
});

test('buildProfileContext controlSocketPath on darwin via withPlatform', () => {
  withPlatform('darwin', () => {
    const ctx = buildProfileContext('prod');
    expect(ctx.controlSocketPath.endsWith(join('prod', 'control.sock'))).toBe(true);
  });
});

test('buildProfileContext controlSocketPath on linux via withPlatform', () => {
  withPlatform('linux', () => {
    const ctx = buildProfileContext('dev');
    expect(ctx.controlSocketPath.endsWith(join('dev', 'control.sock'))).toBe(true);
  });
});

test('buildProfileContext controlSocketPath on win32 starts with pipe prefix and contains profile', () => {
  withPlatform('win32', () => {
    const prodCtx = buildProfileContext('prod');
    expect(prodCtx.controlSocketPath.startsWith('\\\\.\\pipe\\')).toBe(true);
    expect(prodCtx.controlSocketPath).toContain('prod');
    const devCtx = buildProfileContext('dev');
    expect(devCtx.controlSocketPath.startsWith('\\\\.\\pipe\\')).toBe(true);
    expect(devCtx.controlSocketPath).toContain('dev');
  });
});

test('buildProfileContext throws on unsupported platform inside controlSocketPath', () => {
  withPlatform('aix' as NodeJS.Platform, () => {
    expect(() => buildProfileContext('prod')).toThrow('unsupported platform');
  });
});

test('profileRootDir returns PROXAI_TEST_PROFILE_ROOT override when set', () => {
  const original = process.env['PROXAI_TEST_PROFILE_ROOT'];
  const fakeRoot = join('tmp', 'test-profile-root');
  process.env['PROXAI_TEST_PROFILE_ROOT'] = fakeRoot;
  try {
    expect(profileRootDir()).toBe(fakeRoot);
  } finally {
    if (original === undefined) delete process.env['PROXAI_TEST_PROFILE_ROOT'];
    else process.env['PROXAI_TEST_PROFILE_ROOT'] = original;
  }
});

test('profileLogDirRoot returns PROXAI_TEST_PROFILE_ROOT override when set', () => {
  const original = process.env['PROXAI_TEST_PROFILE_ROOT'];
  const fakeRoot = join('tmp', 'test-log-dir-root');
  process.env['PROXAI_TEST_PROFILE_ROOT'] = fakeRoot;
  try {
    expect(profileLogDirRoot()).toBe(fakeRoot);
  } finally {
    if (original === undefined) delete process.env['PROXAI_TEST_PROFILE_ROOT'];
    else process.env['PROXAI_TEST_PROFILE_ROOT'] = original;
  }
});
