import type { LogLevel } from 'core/log';

export type InstallSource = 'bun' | 'pnpm' | 'yarn' | 'npm' | 'brew' | 'github_release';

export interface AccountConfig {
  apiKey: string;
  hostId: string;
  installedAt: string;
  installSource: InstallSource;
}

export interface BackendConfig {
  ingestUrl: string;
  verifyKeyUrl: string;
}

export interface CaptureConfig {
  pollIntervalSec: number;
  bufferPath: string;
  bufferMaxBytes: number;
}

export interface LoggingConfig {
  level: LogLevel;
  logDir: string;
}

export interface StaleBinaryConfig {
  warnAfterDays: number;
  pauseAfterDays: number;
}

export interface GatewayConfig {
  account: AccountConfig;
  backend: BackendConfig;
  capture: CaptureConfig;
  logging: LoggingConfig;
  staleBinary: StaleBinaryConfig;
}
