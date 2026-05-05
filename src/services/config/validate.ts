import { bufferDbPath, expandHome, logDir } from 'core/io/fs';
import { DEFAULT_LOG_LEVEL, VALID_LOG_LEVELS } from 'core/log';
import type { LogLevel } from 'core/log';
import { ValidationError } from 'core/utils';
import {
  DEFAULT_BUFFER_MAX_BYTES,
  DEFAULT_INGEST_URL,
  DEFAULT_POLL_INTERVAL_SEC,
  DEFAULT_STALE_PAUSE_DAYS,
  DEFAULT_STALE_WARN_DAYS,
  DEFAULT_VERIFY_KEY_URL,
  MAX_POLL_INTERVAL_SEC,
  MIN_BUFFER_MAX_BYTES,
  MIN_POLL_INTERVAL_SEC,
  VALID_INSTALL_SOURCES,
} from 'services/config/config.constants.ts';
import type {
  AccountConfig,
  BackendConfig,
  CaptureConfig,
  GatewayConfig,
  InstallSource,
  LoggingConfig,
  StaleBinaryConfig,
} from 'services/config/config.types.ts';

export function validateAndCoerce(raw: unknown): GatewayConfig {
  const root = requireTable(raw, 'root');
  return {
    account: validateAccount(root['account']),
    backend: validateBackend(root['backend']),
    capture: validateCapture(root['capture']),
    logging: validateLogging(root['logging']),
    staleBinary: validateStaleBinary(root['stale_binary']),
  };
}

function validateAccount(raw: unknown): AccountConfig {
  const r = requireTable(raw, 'account');
  return {
    apiKey: requireString(r['api_key'], 'account.api_key'),
    hostId: requireString(r['host_id'], 'account.host_id'),
    installedAt: requireString(r['installed_at'], 'account.installed_at'),
    installSource: parseInstallSource(r['install_source']),
  };
}

function validateBackend(raw: unknown): BackendConfig {
  const r = optionalTable(raw, 'backend');
  return {
    ingestUrl: optionalString(r['ingest_url'], DEFAULT_INGEST_URL, 'backend.ingest_url'),
    verifyKeyUrl: optionalString(
      r['verify_key_url'],
      DEFAULT_VERIFY_KEY_URL,
      'backend.verify_key_url',
    ),
  };
}

function validateCapture(raw: unknown): CaptureConfig {
  const r = optionalTable(raw, 'capture');
  const bufferPathRaw = r['buffer_path'];
  const bufferPath =
    bufferPathRaw === undefined
      ? bufferDbPath()
      : expandHome(requireString(bufferPathRaw, 'capture.buffer_path'));
  return {
    pollIntervalSec: optionalNumber(
      r['poll_interval_sec'],
      DEFAULT_POLL_INTERVAL_SEC,
      'capture.poll_interval_sec',
      MIN_POLL_INTERVAL_SEC,
      MAX_POLL_INTERVAL_SEC,
    ),
    bufferPath,
    bufferMaxBytes: optionalNumber(
      r['buffer_max_bytes'],
      DEFAULT_BUFFER_MAX_BYTES,
      'capture.buffer_max_bytes',
      MIN_BUFFER_MAX_BYTES,
    ),
  };
}

function validateLogging(raw: unknown): LoggingConfig {
  const r = optionalTable(raw, 'logging');
  const dirRaw = r['log_dir'];
  const dir =
    dirRaw === undefined ? logDir() : expandHome(requireString(dirRaw, 'logging.log_dir'));
  return {
    level: parseLogLevel(r['level'], DEFAULT_LOG_LEVEL),
    logDir: dir,
  };
}

function validateStaleBinary(raw: unknown): StaleBinaryConfig {
  const r = optionalTable(raw, 'stale_binary');
  return {
    warnAfterDays: optionalNumber(
      r['warn_after_days'],
      DEFAULT_STALE_WARN_DAYS,
      'stale_binary.warn_after_days',
      0,
    ),
    pauseAfterDays: optionalNumber(
      r['pause_after_days'],
      DEFAULT_STALE_PAUSE_DAYS,
      'stale_binary.pause_after_days',
      0,
    ),
  };
}

function requireTable(value: unknown, fieldPath: string): Record<string, unknown> {
  if (value === undefined || value === null) {
    throw new ValidationError(`[${fieldPath}] is required`);
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`[${fieldPath}] must be a TOML table`);
  }
  return value as Record<string, unknown>;
}

function optionalTable(value: unknown, fieldPath: string): Record<string, unknown> {
  if (value === undefined) return {};
  return requireTable(value, fieldPath);
}

function requireString(value: unknown, fieldPath: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${fieldPath} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, fallback: string, fieldPath: string): string {
  if (value === undefined) return fallback;
  return requireString(value, fieldPath);
}

function optionalNumber(
  value: unknown,
  fallback: number,
  fieldPath: string,
  min?: number,
  max?: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(`${fieldPath} must be a finite number`);
  }
  if (min !== undefined && value < min) {
    throw new ValidationError(`${fieldPath} must be >= ${min}`);
  }
  if (max !== undefined && value > max) {
    throw new ValidationError(`${fieldPath} must be <= ${max}`);
  }
  return value;
}

function parseInstallSource(value: unknown): InstallSource {
  if (typeof value !== 'string') {
    throw new ValidationError('account.install_source must be a string');
  }
  if (!VALID_INSTALL_SOURCES.includes(value as InstallSource)) {
    throw new ValidationError(
      `account.install_source must be one of: ${VALID_INSTALL_SOURCES.join(', ')}`,
    );
  }
  return value as InstallSource;
}

function parseLogLevel(value: unknown, fallback: LogLevel): LogLevel {
  if (value === undefined) return fallback;
  if (typeof value !== 'string') {
    throw new ValidationError('logging.level must be a string');
  }
  if (!VALID_LOG_LEVELS.includes(value as LogLevel)) {
    throw new ValidationError(`logging.level must be one of: ${VALID_LOG_LEVELS.join(', ')}`);
  }
  return value as LogLevel;
}
