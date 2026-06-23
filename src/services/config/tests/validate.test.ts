import { expect, test } from 'bun:test';
import { join } from 'node:path';

import { ValidationError } from 'core/utils';
import { loadConfigFromString } from 'services/config/loader.ts';
import {
  DEFAULT_BUFFER_SOFT_PAUSE_BYTES,
  DEFAULT_BUFFER_SOFT_RESUME_BYTES,
  DEFAULT_FAILED_RETENTION_DAYS,
  DEFAULT_POLL_INTERVAL_SEC,
  DEFAULT_RECEIPT_RETENTION_DAYS,
  DEFAULT_STALE_PAUSE_DAYS,
  DEFAULT_STALE_WARN_DAYS,
  nestIngestUrl,
  nestVerifyKeyUrl,
  nestWatermarksUrl,
  validateAndCoerce,
} from 'services/config';
import { buildProfileContext } from 'core/io/fs/profile.ts';

const prodBaseUrl = buildProfileContext('prod').defaultNestBaseUrl;

const minimalAccount = {
  api_key: 'pxg_live_test',
  user_id: 'u_1',
  host_id: '01HZ-host-id',
  installed_at: '2026-04-28T22:30:00Z',
  install_source: 'bun',
};

test('rejects non-object root', () => {
  expect(() => validateAndCoerce(null)).toThrow(ValidationError);
  expect(() => validateAndCoerce('string')).toThrow(ValidationError);
  expect(() => validateAndCoerce([])).toThrow(ValidationError);
});

test('requires the [account] section', () => {
  expect(() => validateAndCoerce({})).toThrow(/account/);
});

test('requires every account field', () => {
  expect(() => validateAndCoerce({ account: {} })).toThrow(/account\.api_key/);
  expect(() => validateAndCoerce({ account: { api_key: 'k' } })).toThrow(/account\.user_id/);
  expect(() => validateAndCoerce({ account: { api_key: 'k', user_id: 'u_1' } })).toThrow(
    /account\.host_id/,
  );
});

test('rejects empty strings as missing', () => {
  expect(() => validateAndCoerce({ account: { ...minimalAccount, api_key: '' } })).toThrow(
    /api_key/,
  );
});

test('rejects invalid install_source', () => {
  expect(() =>
    validateAndCoerce({ account: { ...minimalAccount, install_source: 'rabbit' } }),
  ).toThrow(/install_source/);
});

test('rejects non-string install_source', () => {
  expect(() => validateAndCoerce({ account: { ...minimalAccount, install_source: 42 } })).toThrow(
    /install_source must be a string/,
  );
});

test('rejects invalid log level', () => {
  expect(() =>
    validateAndCoerce({ account: minimalAccount, logging: { level: 'verbose' } }),
  ).toThrow(/logging\.level/);
});

test('rejects non-string log level', () => {
  expect(() => validateAndCoerce({ account: minimalAccount, logging: { level: 3 } })).toThrow(
    /logging\.level must be a string/,
  );
});

test('rejects upload_max_batches_per_sec below 0.1', () => {
  expect(() =>
    validateAndCoerce({
      account: minimalAccount,
      capture: { upload_max_batches_per_sec: 0.001 },
    }),
  ).toThrow(/upload_max_batches_per_sec/);
});

test('accepts upload_max_batches_per_sec at 0.5', () => {
  const result = validateAndCoerce({
    account: minimalAccount,
    capture: { upload_max_batches_per_sec: 0.5 },
  });
  expect(result.capture.uploadMaxBatchesPerSec).toBe(0.5);
});

test('rejects out-of-range poll interval', () => {
  expect(() =>
    validateAndCoerce({ account: minimalAccount, capture: { poll_interval_sec: 5 } }),
  ).toThrow(/poll_interval_sec/);
  expect(() =>
    validateAndCoerce({ account: minimalAccount, capture: { poll_interval_sec: 100_000 } }),
  ).toThrow(/poll_interval_sec/);
});

test('rejects non-numeric numeric fields', () => {
  expect(() =>
    validateAndCoerce({ account: minimalAccount, capture: { poll_interval_sec: '300' } }),
  ).toThrow(/poll_interval_sec/);
});

test('applies defaults for missing optional sections', () => {
  const result = validateAndCoerce({ account: minimalAccount });
  expect(result.backend.ingestUrl).toBe(nestIngestUrl(prodBaseUrl));
  expect(result.backend.verifyKeyUrl).toBe(nestVerifyKeyUrl(prodBaseUrl));
  expect(result.backend.watermarksUrl).toBe(nestWatermarksUrl(prodBaseUrl));
  expect(result.capture.pollIntervalSec).toBe(DEFAULT_POLL_INTERVAL_SEC);
  expect(result.capture.receiptRetentionDays).toBe(DEFAULT_RECEIPT_RETENTION_DAYS);
  expect(result.capture.failedRetentionDays).toBe(DEFAULT_FAILED_RETENTION_DAYS);
  expect(result.capture.bufferSoftPauseBytes).toBe(DEFAULT_BUFFER_SOFT_PAUSE_BYTES);
  expect(result.capture.bufferSoftResumeBytes).toBe(DEFAULT_BUFFER_SOFT_RESUME_BYTES);
  expect(result.logging.level).toBe('info');
  expect(result.staleBinary.warnAfterDays).toBe(DEFAULT_STALE_WARN_DAYS);
  expect(result.staleBinary.pauseAfterDays).toBe(DEFAULT_STALE_PAUSE_DAYS);
});

test('respects user-provided overrides', () => {
  const result = validateAndCoerce({
    account: minimalAccount,
    backend: { ingest_url: 'https://example.com/v1/raw_records' },
    capture: {
      poll_interval_sec: 600,
      receipt_retention_days: 7,
      failed_retention_days: 14,
      buffer_soft_pause_bytes: 100_000_000,
      buffer_soft_resume_bytes: 50_000_000,
    },
    logging: { level: 'debug' },
    stale_binary: { warn_after_days: 30, pause_after_days: 60 },
  });
  expect(result.backend.ingestUrl).toBe('https://example.com/v1/raw_records');
  expect(result.capture.pollIntervalSec).toBe(600);
  expect(result.capture.receiptRetentionDays).toBe(7);
  expect(result.capture.failedRetentionDays).toBe(14);
  expect(result.capture.bufferSoftPauseBytes).toBe(100_000_000);
  expect(result.capture.bufferSoftResumeBytes).toBe(50_000_000);
  expect(result.logging.level).toBe('debug');
  expect(result.staleBinary.warnAfterDays).toBe(30);
  expect(result.staleBinary.pauseAfterDays).toBe(60);
});

test('rejects buffer_soft_resume_bytes >= buffer_soft_pause_bytes', () => {
  expect(() =>
    validateAndCoerce({
      account: minimalAccount,
      capture: {
        buffer_soft_pause_bytes: 100,
        buffer_soft_resume_bytes: 100,
      },
    }),
  ).toThrow(/resume/);
  expect(() =>
    validateAndCoerce({
      account: minimalAccount,
      capture: {
        buffer_soft_pause_bytes: 100,
        buffer_soft_resume_bytes: 200,
      },
    }),
  ).toThrow(/resume/);
});

test('expands ~/ in path fields', () => {
  const result = validateAndCoerce({
    account: minimalAccount,
    capture: { buffer_path: '~/custom/buffer.db' },
    logging: { log_dir: '~/custom/logs' },
  });
  expect(result.capture.bufferPath.startsWith('~')).toBe(false);
  expect(result.capture.bufferPath.endsWith(join('custom', 'buffer.db'))).toBe(true);
  expect(result.logging.logDir.startsWith('~')).toBe(false);
  expect(result.logging.logDir.endsWith(join('custom', 'logs'))).toBe(true);
});

test('accepts max_decompressed_bytes as a positive finite number', () => {
  const result = validateAndCoerce({
    account: minimalAccount,
    capture: { max_decompressed_bytes: 9 * 1024 * 1024 },
  });
  expect(result.capture.maxDecompressedBytes).toBe(9 * 1024 * 1024);
});

test('accepts max_decompressed_bytes set to +Infinity (kill switch)', () => {
  const result = validateAndCoerce({
    account: minimalAccount,
    capture: { max_decompressed_bytes: Number.POSITIVE_INFINITY },
  });
  expect(result.capture.maxDecompressedBytes).toBe(Number.POSITIVE_INFINITY);
});

test('omits max_decompressed_bytes when not provided', () => {
  const result = validateAndCoerce({ account: minimalAccount });
  expect(result.capture.maxDecompressedBytes).toBeUndefined();
});

test('rejects non-numeric max_decompressed_bytes', () => {
  expect(() =>
    validateAndCoerce({
      account: minimalAccount,
      capture: { max_decompressed_bytes: 'lots' },
    }),
  ).toThrow(/max_decompressed_bytes/);
});

test('rejects NaN max_decompressed_bytes', () => {
  expect(() =>
    validateAndCoerce({
      account: minimalAccount,
      capture: { max_decompressed_bytes: Number.NaN },
    }),
  ).toThrow(/finite or \+Infinity/);
});

test('rejects max_decompressed_bytes <= 0', () => {
  expect(() =>
    validateAndCoerce({
      account: minimalAccount,
      capture: { max_decompressed_bytes: 0 },
    }),
  ).toThrow(/> 0/);
  expect(() =>
    validateAndCoerce({
      account: minimalAccount,
      capture: { max_decompressed_bytes: -1 },
    }),
  ).toThrow(/> 0/);
});

test('camelCase output mirrors snake_case input', () => {
  const result = validateAndCoerce({ account: minimalAccount });
  expect(result.account.apiKey).toBe('pxg_live_test');
  expect(result.account.userId).toBe('u_1');
  expect(result.account.hostId).toBe('01HZ-host-id');
  expect(result.account.installedAt).toBe('2026-04-28T22:30:00Z');
  expect(result.account.installSource).toBe('bun');
});

const BASE = `
[account]
api_key = "k"
user_id = "u"
host_id = "h"
installed_at = "2026-01-01T00:00:00.000Z"
install_source = "github_release"
[backend]
ingest_url = "http://localhost/v1/raw_records"
[capture]
buffer_path = "/tmp/b.db"
[logging]
log_dir = "/tmp/logs"
[stale_binary]
`;

test('excluded_projects defaults to [] when absent', () => {
  expect(loadConfigFromString(BASE).capture.excludedProjects).toEqual([]);
});

test('excluded_projects parses + trims a string array', () => {
  // Inline into BASE's existing [capture] table — a SECOND [capture] table makes smol-toml throw.
  const text = BASE.replace(
    'buffer_path = "/tmp/b.db"',
    'buffer_path = "/tmp/b.db"\nexcluded_projects = ["  /Users/me/a  ", "~/b"]',
  );
  expect(loadConfigFromString(text).capture.excludedProjects).toEqual(['/Users/me/a', '~/b']);
});

test('excluded_projects throws when not an array', () => {
  const text = BASE.replace(
    'buffer_path = "/tmp/b.db"',
    'buffer_path = "/tmp/b.db"\nexcluded_projects = "x"',
  );
  expect(() => loadConfigFromString(text)).toThrow(/excluded_projects must be an array/);
});

test('excluded_projects throws on a non-string entry', () => {
  const text = BASE.replace(
    'buffer_path = "/tmp/b.db"',
    'buffer_path = "/tmp/b.db"\nexcluded_projects = [1]',
  );
  expect(() => loadConfigFromString(text)).toThrow(/excluded_projects\[0\] must be a string/);
});
