import { homedir } from 'node:os';
import { join } from 'node:path';

import { buildProfileContext, profileRootDir } from 'core/io/fs/profile.ts';

export function configDir(): string {
  return buildProfileContext('prod').configDir;
}

export function logDir(): string {
  return buildProfileContext('prod').logDir;
}

export function bufferDbPath(): string {
  return buildProfileContext('prod').bufferDbPath;
}

export function configFilePath(): string {
  return buildProfileContext('prod').configFilePath;
}

export function authFailedSentinelPath(): string {
  return buildProfileContext('prod').sentinels.authFailed;
}

export function bufferFullSentinelPath(): string {
  return buildProfileContext('prod').sentinels.bufferFull;
}

export function sessionStoppedSentinelPath(): string {
  return buildProfileContext('prod').sentinels.sessionStopped;
}

export function consentSentinelPath(): string {
  return buildProfileContext('prod').sentinels.consent;
}

export function updateAvailableSentinelPath(): string {
  return buildProfileContext('prod').sentinels.updateAvailable;
}

export function controlSocketPath(): string {
  return buildProfileContext('prod').controlSocketPath;
}

export function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

export function legacyRootDir(): string {
  return profileRootDir();
}
