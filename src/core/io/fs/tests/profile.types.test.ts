import { expect, test } from 'bun:test';

import type { ProfileContext, ProfileSentinelPaths } from 'core/io/fs/profile.types.ts';
import { VALID_PROFILES } from 'core/io/fs/profile.types.ts';

test('VALID_PROFILES contains prod and dev in order', () => {
  expect(VALID_PROFILES).toEqual(['prod', 'dev']);
});

test('VALID_PROFILES is readonly and has length 2', () => {
  expect(VALID_PROFILES.length).toBe(2);
});

test('ProfileSentinelPaths shape is structurally correct at type level', () => {
  const sentinels: ProfileSentinelPaths = {
    authFailed: '/a',
    bufferFull: '/b',
    sessionStopped: '/c',
    consent: '/d',
    updateAvailable: '/e',
    rescueLedger: '/f',
  };
  expect(Object.keys(sentinels).length).toBe(6);
});

test('ProfileContext shape is structurally correct at type level', () => {
  const ctx: ProfileContext = {
    name: 'prod',
    isDev: false,
    configDir: '/config',
    configFilePath: '/config/config.toml',
    bufferDbPath: '/config/buffer.db',
    logDir: '/logs',
    sentinels: {
      authFailed: '/config/AUTH_FAILED',
      bufferFull: '/config/BUFFER_FULL',
      sessionStopped: '/config/SESSION_STOPPED',
      consent: '/config/CONSENT_ACCEPTED',
      updateAvailable: '/config/UPDATE_AVAILABLE',
      rescueLedger: '/config/RESCUE_LEDGER',
    },
    controlSocketPath: '/config/control.sock',
    defaultNestBaseUrl: 'https://proxainest-production.up.railway.app',
  };
  expect(ctx.name).toBe('prod');
  expect(ctx.isDev).toBe(false);
});
