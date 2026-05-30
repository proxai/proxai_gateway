import { homedir } from 'node:os';
import { join } from 'node:path';

import { APP_NAME, ORG_NAME } from 'core/io/fs/fs.constants.ts';
import type {
  ProfileContext,
  ProfileName,
  ProfileSentinelPaths,
} from 'core/io/fs/profile.types.ts';

const PROD_NEST_BASE_URL = 'https://proxainest-production.up.railway.app';
const DEV_NEST_BASE_URL = 'http://localhost:3001';

export function profileRootDir(): string {
  if (process.env['PROXAI_TEST_PROFILE_ROOT']) {
    return process.env['PROXAI_TEST_PROFILE_ROOT'];
  }
  switch (process.platform) {
    case 'darwin':
    case 'linux':
      return join(homedir(), `.${ORG_NAME}`, APP_NAME);
    case 'win32':
      return join(
        process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'),
        ORG_NAME,
        APP_NAME,
      );
    default:
      throw new Error(`unsupported platform: ${process.platform}`);
  }
}

export function profileLogDirRoot(): string {
  if (process.env['PROXAI_TEST_PROFILE_ROOT']) {
    return process.env['PROXAI_TEST_PROFILE_ROOT'];
  }
  switch (process.platform) {
    case 'darwin':
      return join(homedir(), 'Library', 'Logs', ORG_NAME, APP_NAME);
    case 'linux':
      return join(homedir(), '.local', 'state', ORG_NAME, APP_NAME, 'log');
    case 'win32':
      return join(
        process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'),
        ORG_NAME,
        APP_NAME,
        'Logs',
      );
    default:
      throw new Error(`unsupported platform: ${process.platform}`);
  }
}

function buildSentinelPaths(configDir: string): ProfileSentinelPaths {
  return {
    authFailed: join(configDir, 'AUTH_FAILED'),
    bufferFull: join(configDir, 'BUFFER_FULL'),
    sessionStopped: join(configDir, 'SESSION_STOPPED'),
    consent: join(configDir, 'CONSENT_ACCEPTED'),
    updateAvailable: join(configDir, 'UPDATE_AVAILABLE'),
  };
}

function buildControlSocketPath(profile: ProfileName, configDir: string): string {
  switch (process.platform) {
    case 'darwin':
    case 'linux':
      return join(configDir, 'control.sock');
    case 'win32':
      return `\\\\.\\pipe\\${APP_NAME}-control-${profile}`;
    default:
      throw new Error(`unsupported platform: ${process.platform}`);
  }
}

export function buildProfileContext(profile: ProfileName): ProfileContext {
  const configDir = join(profileRootDir(), profile);
  const logDir = join(profileLogDirRoot(), profile);
  return {
    name: profile,
    isDev: profile === 'dev',
    configDir,
    configFilePath: join(configDir, 'config.toml'),
    bufferDbPath: join(configDir, 'buffer.db'),
    logDir,
    sentinels: buildSentinelPaths(configDir),
    controlSocketPath: buildControlSocketPath(profile, configDir),
    defaultNestBaseUrl: profile === 'dev' ? DEV_NEST_BASE_URL : PROD_NEST_BASE_URL,
  };
}
