import { homedir } from 'node:os';
import { join } from 'node:path';

import { APP_NAME, ORG_NAME } from 'core/io/fs/fs.constants.ts';

export function configDir(): string {
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

export function logDir(): string {
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

export function bufferDbPath(): string {
  return join(configDir(), 'buffer.db');
}

export function configFilePath(): string {
  return join(configDir(), 'config.toml');
}

export function pausedSentinelPath(): string {
  return join(configDir(), 'PAUSED');
}

export function authFailedSentinelPath(): string {
  return join(configDir(), 'AUTH_FAILED');
}

export function bufferFullSentinelPath(): string {
  return join(configDir(), 'BUFFER_FULL');
}

export function sessionStoppedSentinelPath(): string {
  return join(configDir(), 'SESSION_STOPPED');
}

export function consentSentinelPath(): string {
  return join(configDir(), 'CONSENT_ACCEPTED');
}

export function controlSocketPath(): string {
  switch (process.platform) {
    case 'darwin':
    case 'linux':
      return join(configDir(), 'control.sock');
    case 'win32':
      return `\\\\.\\pipe\\${APP_NAME}-control`;
    default:
      throw new Error(`unsupported platform: ${process.platform}`);
  }
}

export function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    return join(homedir(), path.slice(2));
  }
  return path;
}
