import type { LogLevel } from 'core/log';

export type InstallSource = 'bun' | 'pnpm' | 'yarn' | 'npm' | 'brew' | 'github_release';

export interface AccountConfig {
  apiKey: string;
  userId: string;
  hostId: string;
  installedAt: string;
  installSource: InstallSource;
}

export interface BackendConfig {
  ingestUrl: string;
  verifyKeyUrl: string;
  watermarksUrl: string;
  registerHostIdUrl: string;
}

export interface CaptureConfig {
  pollIntervalSec: number;
  bufferPath: string;
  receiptRetentionDays: number;
  failedRetentionDays: number;
  bufferSoftPauseBytes: number;
  bufferSoftResumeBytes: number;
  initialScanWindowDays: number;
  uploadMaxBatchesPerSec: number;
  uploadMaxBytesPerMinute: number;
  uploadBackoffOn429Multiplier: number;
  maxDecompressedBytes?: number;
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
