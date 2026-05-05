import type { InstallSource } from 'services/config/config.types.ts';

const PROD_URL = 'https://proxainest-production.up.railway.app';
const DEV_URL = 'http://localhost:3001';

export function resolveNestBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env['PROXAI_NEST_URL']?.trim();
  if (override !== undefined && override.length > 0) {
    return override.replace(/\/$/, '');
  }
  if (env['NODE_ENV'] === 'development') return DEV_URL;
  return PROD_URL;
}

export const NEST_BASE_URL = resolveNestBaseUrl();
export const NEST_INGEST_URL = `${NEST_BASE_URL}/v1/raw_records`;
export const NEST_VERIFY_KEY_URL = `${NEST_BASE_URL}/ingestion/verify-key`;

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
