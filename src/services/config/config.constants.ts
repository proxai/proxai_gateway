import type { InstallSource } from 'services/config/config.types.ts';

export const DEFAULT_INGEST_URL = 'https://nest.proxai.co/v1/raw_records';
export const DEFAULT_HEALTH_URL = 'https://nest.proxai.co/health';

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
