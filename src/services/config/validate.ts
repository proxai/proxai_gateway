import { expandHome } from 'core/io/fs';
import { DEFAULT_LOG_LEVEL, VALID_LOG_LEVELS } from 'core/log';
import type { LogLevel } from 'core/log';
import { ValidationError } from 'core/utils';
import { buildProfileContext } from 'core/io/fs/profile.ts';
import {
  DEFAULT_BUFFER_SOFT_PAUSE_BYTES,
  DEFAULT_BUFFER_SOFT_RESUME_BYTES,
  DEFAULT_FAILED_RETENTION_DAYS,
  DEFAULT_POLL_INTERVAL_SEC,
  DEFAULT_RECEIPT_RETENTION_DAYS,
  DEFAULT_STALE_PAUSE_DAYS,
  DEFAULT_STALE_WARN_DAYS,
  DEFAULT_UPLOAD_BACKOFF_ON_429_MULTIPLIER,
  DEFAULT_UPLOAD_MAX_BATCHES_PER_SEC,
  DEFAULT_UPLOAD_MAX_BYTES_PER_MINUTE,
  MAX_POLL_INTERVAL_SEC,
  MIN_POLL_INTERVAL_SEC,
  MIN_UPLOAD_MAX_BATCHES_PER_SEC,
  nestIngestUrl,
  nestRegisterHostIdUrl,
  nestVerifyKeyUrl,
  nestWatermarksUrl,
  VALID_INSTALL_SOURCES,
} from 'services/config/config.constants.ts';

export interface ValidateDefaults {
  readonly defaultBufferPath: string;
  readonly defaultLogDir: string;
}
import type {
  AccountConfig,
  BackendConfig,
  CaptureConfig,
  GatewayConfig,
  InstallSource,
  LoggingConfig,
  StaleBinaryConfig,
} from 'services/config/config.types.ts';

export function validateAndCoerce(raw: unknown, defaults?: ValidateDefaults): GatewayConfig {
  const root = requireTable(raw, 'root');
  return {
    account: validateAccount(root['account']),
    backend: validateBackend(root['backend']),
    capture: validateCapture(root['capture'], defaults),
    logging: validateLogging(root['logging'], defaults),
    staleBinary: validateStaleBinary(root['stale_binary']),
  };
}

function validateAccount(raw: unknown): AccountConfig {
  const r = requireTable(raw, 'account');
  return {
    apiKey: requireString(r['api_key'], 'account.api_key'),
    userId: requireString(r['user_id'], 'account.user_id'),
    hostId: requireString(r['host_id'], 'account.host_id'),
    installedAt: requireString(r['installed_at'], 'account.installed_at'),
    installSource: parseInstallSource(r['install_source']),
  };
}

function validateBackend(raw: unknown): BackendConfig {
  const r = optionalTable(raw, 'backend');
  const baseUrl = buildProfileContext('prod').defaultNestBaseUrl;
  return {
    ingestUrl: optionalString(r['ingest_url'], nestIngestUrl(baseUrl), 'backend.ingest_url'),
    verifyKeyUrl: optionalString(
      r['verify_key_url'],
      nestVerifyKeyUrl(baseUrl),
      'backend.verify_key_url',
    ),
    watermarksUrl: optionalString(
      r['watermarks_url'],
      nestWatermarksUrl(baseUrl),
      'backend.watermarks_url',
    ),
    registerHostIdUrl: optionalString(
      r['register_host_id_url'],
      nestRegisterHostIdUrl(baseUrl),
      'backend.register_host_id_url',
    ),
  };
}

function validateCapture(raw: unknown, defaults?: ValidateDefaults): CaptureConfig {
  const r = optionalTable(raw, 'capture');
  const bufferPathRaw = r['buffer_path'];
  const bufferPath =
    bufferPathRaw === undefined
      ? (defaults?.defaultBufferPath ?? buildProfileContext('prod').bufferDbPath)
      : expandHome(requireString(bufferPathRaw, 'capture.buffer_path'));
  const bufferSoftPauseBytes = optionalNumber(
    r['buffer_soft_pause_bytes'],
    DEFAULT_BUFFER_SOFT_PAUSE_BYTES,
    'capture.buffer_soft_pause_bytes',
    1,
  );
  const bufferSoftResumeBytes = optionalNumber(
    r['buffer_soft_resume_bytes'],
    DEFAULT_BUFFER_SOFT_RESUME_BYTES,
    'capture.buffer_soft_resume_bytes',
    0,
  );
  if (bufferSoftResumeBytes >= bufferSoftPauseBytes) {
    throw new ValidationError(
      'capture.buffer_soft_resume_bytes must be less than capture.buffer_soft_pause_bytes',
    );
  }

  const capture: CaptureConfig = {
    pollIntervalSec: optionalNumber(
      r['poll_interval_sec'],
      DEFAULT_POLL_INTERVAL_SEC,
      'capture.poll_interval_sec',
      MIN_POLL_INTERVAL_SEC,
      MAX_POLL_INTERVAL_SEC,
    ),
    bufferPath,
    receiptRetentionDays: optionalNumber(
      r['receipt_retention_days'],
      DEFAULT_RECEIPT_RETENTION_DAYS,
      'capture.receipt_retention_days',
      0,
    ),
    failedRetentionDays: optionalNumber(
      r['failed_retention_days'],
      DEFAULT_FAILED_RETENTION_DAYS,
      'capture.failed_retention_days',
      0,
    ),
    bufferSoftPauseBytes,
    bufferSoftResumeBytes,
    uploadMaxBatchesPerSec: optionalNumber(
      r['upload_max_batches_per_sec'],
      DEFAULT_UPLOAD_MAX_BATCHES_PER_SEC,
      'capture.upload_max_batches_per_sec',
      MIN_UPLOAD_MAX_BATCHES_PER_SEC,
    ),
    uploadMaxBytesPerMinute: optionalNumber(
      r['upload_max_bytes_per_minute'],
      DEFAULT_UPLOAD_MAX_BYTES_PER_MINUTE,
      'capture.upload_max_bytes_per_minute',
      1,
    ),
    uploadBackoffOn429Multiplier: optionalNumber(
      r['upload_backoff_on_429_multiplier'],
      DEFAULT_UPLOAD_BACKOFF_ON_429_MULTIPLIER,
      'capture.upload_backoff_on_429_multiplier',
      1,
    ),
  };
  const maxDecompressed = optionalPositiveNumberOrInfinity(
    r['max_decompressed_bytes'],
    'capture.max_decompressed_bytes',
  );
  if (maxDecompressed !== undefined) {
    capture.maxDecompressedBytes = maxDecompressed;
  }
  return capture;
}

function validateLogging(raw: unknown, defaults?: ValidateDefaults): LoggingConfig {
  const r = optionalTable(raw, 'logging');
  const dirRaw = r['log_dir'];
  const dir =
    dirRaw === undefined
      ? (defaults?.defaultLogDir ?? buildProfileContext('prod').logDir)
      : expandHome(requireString(dirRaw, 'logging.log_dir'));
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

function optionalPositiveNumberOrInfinity(value: unknown, fieldPath: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number') {
    throw new ValidationError(`${fieldPath} must be a number`);
  }
  if (!Number.isFinite(value) && value !== Number.POSITIVE_INFINITY) {
    throw new ValidationError(`${fieldPath} must be finite or +Infinity`);
  }
  if (value <= 0) {
    throw new ValidationError(`${fieldPath} must be > 0`);
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
