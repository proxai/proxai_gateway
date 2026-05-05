import { expect, test } from 'bun:test';

import { ValidationError } from 'core/utils';
import { validateAndCoerce } from 'services/config';

const VALID_BASE = {
  account: {
    api_key: 'pxg_x',
    host_id: 'h_x',
    installed_at: '2026-04-29T10:42:00.123Z',
    install_source: 'github_release',
  },
};

test('throws when install_source is not a string', () => {
  expect(() =>
    validateAndCoerce({
      ...VALID_BASE,
      account: { ...VALID_BASE.account, install_source: 123 },
    }),
  ).toThrow(/install_source must be a string/);
});

test('throws when install_source is an unsupported string value', () => {
  expect(() =>
    validateAndCoerce({
      ...VALID_BASE,
      account: { ...VALID_BASE.account, install_source: 'made-up' },
    }),
  ).toThrow(ValidationError);
});

test('accepts every valid install_source option', () => {
  for (const src of ['bun', 'pnpm', 'yarn', 'npm', 'brew', 'github_release']) {
    expect(() =>
      validateAndCoerce({
        ...VALID_BASE,
        account: { ...VALID_BASE.account, install_source: src },
      }),
    ).not.toThrow();
  }
});

test('throws when logging.level is not a string', () => {
  expect(() =>
    validateAndCoerce({
      ...VALID_BASE,
      logging: { level: 123 },
    }),
  ).toThrow(/level must be a string/);
});

test('throws when logging.level is unsupported', () => {
  expect(() =>
    validateAndCoerce({
      ...VALID_BASE,
      logging: { level: 'verbose' },
    }),
  ).toThrow(/level must be one of/);
});

test('throws when capture.poll_interval_sec is not a number', () => {
  expect(() =>
    validateAndCoerce({
      ...VALID_BASE,
      capture: { poll_interval_sec: 'fast' },
    }),
  ).toThrow(/finite number/);
});

test('throws when capture.poll_interval_sec is below minimum', () => {
  expect(() =>
    validateAndCoerce({
      ...VALID_BASE,
      capture: { poll_interval_sec: 1 },
    }),
  ).toThrow(/must be >=/);
});

test('throws when capture.poll_interval_sec is above maximum', () => {
  expect(() =>
    validateAndCoerce({
      ...VALID_BASE,
      capture: { poll_interval_sec: 999_999 },
    }),
  ).toThrow(/must be <=/);
});

test('throws when account is missing', () => {
  expect(() => validateAndCoerce({})).toThrow(/account/);
});

test('throws when root is not a table', () => {
  expect(() => validateAndCoerce(null)).toThrow(/required/);
});

test('throws when root is an array', () => {
  expect(() => validateAndCoerce([])).toThrow(/TOML table/);
});
