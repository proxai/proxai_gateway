import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { InstallSource } from 'services/config/config.types.ts';
import { profileRootDir } from 'core/io/fs/profile.ts';

const PROD_URL = 'https://proxainest-production.up.railway.app';
const DEV_URL = 'http://localhost:3001';

export function resolveNestBaseUrl(devModeSentinelPath?: string): string {
  const sentinelPath = devModeSentinelPath ?? join(profileRootDir(), 'DEV_MODE');
  try {
    if (existsSync(sentinelPath)) {
      return DEV_URL;
    }
  } catch {}
  return PROD_URL;
}

export const NEST_BASE_URL = resolveNestBaseUrl();
export const NEST_INGEST_URL = `${NEST_BASE_URL}/v1/raw_records`;
export const NEST_VERIFY_KEY_URL = `${NEST_BASE_URL}/ingestion/verify-key`;
export const NEST_WATERMARKS_URL = `${NEST_BASE_URL}/v1/watermarks`;
export const NEST_REGISTER_HOST_ID_URL = `${NEST_BASE_URL}/v1/host-ids/register`;

export const DEFAULT_POLL_INTERVAL_SEC = 300;
export const MIN_POLL_INTERVAL_SEC = 60;
export const MAX_POLL_INTERVAL_SEC = 3600;

export const DEFAULT_RECEIPT_RETENTION_DAYS = 30;
export const DEFAULT_FAILED_RETENTION_DAYS = 30;
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
