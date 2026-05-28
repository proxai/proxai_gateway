import type { InstallSource } from 'services/config/config.types.ts';

export function nestIngestUrl(baseUrl: string): string {
  return `${baseUrl}/v1/raw_records`;
}

export function nestVerifyKeyUrl(baseUrl: string): string {
  return `${baseUrl}/ingestion/verify-key`;
}

export function nestWatermarksUrl(baseUrl: string): string {
  return `${baseUrl}/v1/watermarks`;
}

export function nestRegisterHostIdUrl(baseUrl: string): string {
  return `${baseUrl}/v1/host-ids/register`;
}

export const DEFAULT_POLL_INTERVAL_SEC = 300;
export const MIN_POLL_INTERVAL_SEC = 60;
export const MAX_POLL_INTERVAL_SEC = 3600;

export const DEFAULT_RECEIPT_RETENTION_DAYS = 365;
export const DEFAULT_FAILED_RETENTION_DAYS = 365;
export const DEFAULT_BUFFER_SOFT_PAUSE_BYTES = 50 * 1024 * 1024 * 1024;
export const DEFAULT_BUFFER_SOFT_RESUME_BYTES = 45 * 1024 * 1024 * 1024;

export const DEFAULT_UPLOAD_MAX_BATCHES_PER_SEC = 5;
export const MIN_UPLOAD_MAX_BATCHES_PER_SEC = 0.1;
export const DEFAULT_UPLOAD_MAX_BYTES_PER_MINUTE = 50 * 1024 * 1024;
export const DEFAULT_UPLOAD_BACKOFF_ON_429_MULTIPLIER = 2;

export const DEFAULT_STALE_WARN_DAYS = 30;
export const DEFAULT_STALE_PAUSE_DAYS = 60;

export const VALID_INSTALL_SOURCES: readonly InstallSource[] = [
  'bun',
  'pnpm',
  'yarn',
  'npm',
  'brew',
  'github_release',
];
