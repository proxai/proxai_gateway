import { expect, test } from 'bun:test';

import { ValidationError } from 'core/utils';
import { validateRawRecordDTO, type RawRecordDTO } from 'services/contract';

const VALID_UUIDV7 = '01943f5a-7b1c-7e92-9c01-a0f3b40d77e3';
const VALID_SHA256 = 'a'.repeat(64);
const VALID_BODY = 'aGVsbG8gd29ybGQ=';

function baseDto(overrides: Partial<RawRecordDTO> = {}): RawRecordDTO {
  return {
    capture_id: VALID_UUIDV7,
    host_id: 'h_test',
    source_app: 'claude-code',
    source_kind: 'jsonl_append',
    source_path: '/x',
    source_path_hash: VALID_SHA256,
    source_inode: 1,
    watermark: { kind: 'byte_range', start: 0, end: 100, table: null },
    agent_schema_version: '1.0',
    gateway_version: 'gw',
    captured_at_utc: '2026-04-29T10:42:00.123Z',
    body_format: 'jsonl',
    body_compression: 'zstd',
    body: VALID_BODY,
    ...overrides,
  };
}

test('throws when source_kind is not a recognized value', () => {
  expect(() => validateRawRecordDTO({ ...baseDto(), source_kind: 'bogus' })).toThrow(
    ValidationError,
  );
});

test('throws when body_format is not a recognized value', () => {
  expect(() => validateRawRecordDTO({ ...baseDto(), body_format: 'unknown_format' })).toThrow(
    ValidationError,
  );
});

test('throws when watermark is not an object', () => {
  expect(() => validateRawRecordDTO({ ...baseDto(), watermark: 'not-an-object' })).toThrow(
    /watermark must be an object/,
  );
});

test('throws when watermark is null', () => {
  expect(() => validateRawRecordDTO({ ...baseDto(), watermark: null })).toThrow(
    /watermark must be an object/,
  );
});

test('throws when watermark.kind is not a recognized value', () => {
  expect(() =>
    validateRawRecordDTO({
      ...baseDto(),
      watermark: { kind: 'bogus_kind', start: 0, end: 1, table: null },
    }),
  ).toThrow(ValidationError);
});

test('throws when capture_id is not a string', () => {
  expect(() => validateRawRecordDTO({ ...baseDto(), capture_id: 123 })).toThrow(
    /capture_id must be a string/,
  );
});

test('throws when watermark values exceed MAX_SAFE_WATERMARK', () => {
  expect(() =>
    validateRawRecordDTO({
      ...baseDto(),
      watermark: {
        kind: 'byte_range',
        start: 0,
        end: Number.MAX_SAFE_INTEGER + 1,
        table: null,
      },
    }),
  ).toThrow(ValidationError);
});

test('throws when captured_at_utc is not a string', () => {
  expect(() => validateRawRecordDTO({ ...baseDto(), captured_at_utc: 1234567890 })).toThrow(
    /captured_at_utc must be a string/,
  );
});

test('throws when captured_at_utc is not a parseable date', () => {
  expect(() =>
    validateRawRecordDTO({ ...baseDto(), captured_at_utc: '9999-99-99T99:99:99Z' }),
  ).toThrow(/captured_at_utc/);
});

test('throws when body is not a string', () => {
  expect(() => validateRawRecordDTO({ ...baseDto(), body: 12345 })).toThrow(
    /body must be a base64 string/,
  );
});

test('throws when body is empty string', () => {
  expect(() => validateRawRecordDTO({ ...baseDto(), body: '' })).toThrow(
    /body must be a non-empty base64/,
  );
});

test('throws when body has invalid base64 characters', () => {
  expect(() => validateRawRecordDTO({ ...baseDto(), body: 'not!base64@chars#' })).toThrow(
    /body must be valid base64/,
  );
});

test('throws when body length is not multiple of 4', () => {
  expect(() => validateRawRecordDTO({ ...baseDto(), body: 'aGVsbG8' })).toThrow(/multiple of 4/);
});

test('throws when capture_id is not a UUIDv7', () => {
  expect(() => validateRawRecordDTO({ ...baseDto(), capture_id: 'not-a-uuid' })).toThrow(
    /capture_id must be a UUIDv7/,
  );
});

test('throws when host_id is empty', () => {
  expect(() => validateRawRecordDTO({ ...baseDto(), host_id: '' })).toThrow(
    /host_id must be a non-empty/,
  );
});

test('throws when source_app is not a recognized value', () => {
  expect(() => validateRawRecordDTO({ ...baseDto(), source_app: 'unknown-app' })).toThrow(
    ValidationError,
  );
});

test('throws when watermark.start is greater than watermark.end', () => {
  expect(() =>
    validateRawRecordDTO({
      ...baseDto(),
      watermark: { kind: 'byte_range', start: 100, end: 50, table: null },
    }),
  ).toThrow(/start must be < watermark.end/);
});

test('throws when watermark.start is negative', () => {
  expect(() =>
    validateRawRecordDTO({
      ...baseDto(),
      watermark: { kind: 'byte_range', start: -1, end: 50, table: null },
    }),
  ).toThrow(/non-negative integer/);
});

test('throws when watermark.end is negative', () => {
  expect(() =>
    validateRawRecordDTO({
      ...baseDto(),
      watermark: { kind: 'byte_range', start: 0, end: -1, table: null },
    }),
  ).toThrow(/non-negative integer/);
});

test('throws when byte_range watermark has non-null table', () => {
  expect(() =>
    validateRawRecordDTO({
      ...baseDto(),
      watermark: { kind: 'byte_range', start: 0, end: 1, table: 'something' },
    }),
  ).toThrow(/must be null for byte_range/);
});

test('throws when (app, kind, format, watermark.kind) is not in matrix', () => {
  expect(() =>
    validateRawRecordDTO({
      ...baseDto(),
      source_app: 'cursor',
      source_kind: 'jsonl_append',
      body_format: 'jsonl',
      watermark: { kind: 'byte_range', start: 0, end: 1, table: null },
    }),
  ).toThrow(/allowed matrix/);
});
