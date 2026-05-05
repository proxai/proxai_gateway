import type { InstallSource } from 'services/config/config.types.ts';

export const NEST_BASE_URL_PROD = 'https://proxainest-production.up.railway.app';
export const NEST_BASE_URL_DEV = 'http://localhost:3001';
export const NEST_BASE_URL_ENV_VAR = 'PROXAI_NEST_URL';
export const NODE_ENV_VAR = 'NODE_ENV';
export const NODE_ENV_DEVELOPMENT = 'development';

export const NEST_PATH_INGEST = '/v1/raw_records';
export const NEST_PATH_VERIFY_KEY = '/ingestion/verify-key';

export function defaultNestBaseUrl(): string {
  const override = process.env[NEST_BASE_URL_ENV_VAR];
  if (override !== undefined && override.trim().length > 0) {
    return stripTrailingSlash(override.trim());
  }
  if (process.env[NODE_ENV_VAR] === NODE_ENV_DEVELOPMENT) {
    return NEST_BASE_URL_DEV;
  }
  return NEST_BASE_URL_PROD;
}

export function defaultIngestUrl(): string {
  return `${defaultNestBaseUrl()}${NEST_PATH_INGEST}`;
}

export function defaultVerifyKeyUrl(): string {
  return `${defaultNestBaseUrl()}${NEST_PATH_VERIFY_KEY}`;
}

export const DEFAULT_POLL_INTERVAL_SEC = 300;
export const MIN_POLL_INTERVAL_SEC = 60;
export const MAX_POLL_INTERVAL_SEC = 3600;

export const DEFAULT_BUFFER_MAX_BYTES = 524_288_000;
export const MIN_BUFFER_MAX_BYTES = 1_048_576;

export const DEFAULT_STALE_WARN_DAYS = 90;
export const DEFAULT_STALE_PAUSE_DAYS = 180;

export const VALID_INSTALL_SOURCES: readonly InstallSource[] = [
  'bun',
  'pnpm',
  'yarn',
  'npm',
  'brew',
  'github_release',
];

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}
