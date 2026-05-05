import { expect, test } from 'bun:test';

import { ValidationError } from 'core/utils';
import {
  DEFAULT_BUFFER_MAX_BYTES,
  DEFAULT_INGEST_URL,
  DEFAULT_POLL_INTERVAL_SEC,
  DEFAULT_STALE_PAUSE_DAYS,
  DEFAULT_STALE_WARN_DAYS,
  DEFAULT_VERIFY_KEY_URL,
  validateAndCoerce,
} from 'services/config';

const minimalAccount = {
  api_key: 'pxg_live_test',
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
  expect(() => validateAndCoerce({ account: { api_key: 'k' } })).toThrow(/account\.host_id/);
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

test('rejects invalid log level', () => {
  expect(() =>
    validateAndCoerce({ account: minimalAccount, logging: { level: 'verbose' } }),
  ).toThrow(/logging\.level/);
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
  expect(result.backend.ingestUrl).toBe(DEFAULT_INGEST_URL);
  expect(result.backend.verifyKeyUrl).toBe(DEFAULT_VERIFY_KEY_URL);
  expect(result.capture.pollIntervalSec).toBe(DEFAULT_POLL_INTERVAL_SEC);
  expect(result.capture.bufferMaxBytes).toBe(DEFAULT_BUFFER_MAX_BYTES);
  expect(result.logging.level).toBe('info');
  expect(result.staleBinary.warnAfterDays).toBe(DEFAULT_STALE_WARN_DAYS);
  expect(result.staleBinary.pauseAfterDays).toBe(DEFAULT_STALE_PAUSE_DAYS);
});

test('respects user-provided overrides', () => {
  const result = validateAndCoerce({
    account: minimalAccount,
    backend: { ingest_url: 'https://example.com/v1/raw_records' },
    capture: { poll_interval_sec: 600, buffer_max_bytes: 100_000_000 },
    logging: { level: 'debug' },
    stale_binary: { warn_after_days: 30, pause_after_days: 60 },
  });
  expect(result.backend.ingestUrl).toBe('https://example.com/v1/raw_records');
  expect(result.capture.pollIntervalSec).toBe(600);
  expect(result.capture.bufferMaxBytes).toBe(100_000_000);
  expect(result.logging.level).toBe('debug');
  expect(result.staleBinary.warnAfterDays).toBe(30);
  expect(result.staleBinary.pauseAfterDays).toBe(60);
});

test('expands ~/ in path fields', () => {
  const result = validateAndCoerce({
    account: minimalAccount,
    capture: { buffer_path: '~/custom/buffer.db' },
    logging: { log_dir: '~/custom/logs' },
  });
  expect(result.capture.bufferPath.startsWith('~')).toBe(false);
  expect(result.capture.bufferPath.endsWith('/custom/buffer.db')).toBe(true);
  expect(result.logging.logDir.startsWith('~')).toBe(false);
  expect(result.logging.logDir.endsWith('/custom/logs')).toBe(true);
});

test('camelCase output mirrors snake_case input', () => {
  const result = validateAndCoerce({ account: minimalAccount });
  expect(result.account.apiKey).toBe('pxg_live_test');
  expect(result.account.hostId).toBe('01HZ-host-id');
  expect(result.account.installedAt).toBe('2026-04-28T22:30:00Z');
  expect(result.account.installSource).toBe('bun');
});
