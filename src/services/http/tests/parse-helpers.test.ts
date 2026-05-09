import { expect, test } from 'bun:test';

import { parseServerWatermark, parseWatermarkRegression } from 'services/http/parse-helpers.ts';

test('parseWatermarkRegression: returns null on empty string', () => {
  expect(parseWatermarkRegression('')).toBe(null);
});

test('parseWatermarkRegression: returns null on invalid JSON', () => {
  expect(parseWatermarkRegression('not-json')).toBe(null);
});

test('parseWatermarkRegression: returns null on non-object JSON', () => {
  expect(parseWatermarkRegression('null')).toBe(null);
  expect(parseWatermarkRegression('[]')).toBe(null);
  expect(parseWatermarkRegression('"plain"')).toBe(null);
});

test('parseWatermarkRegression: returns null when error key not watermark_regression', () => {
  expect(parseWatermarkRegression(JSON.stringify({ error: 'other' }))).toBe(null);
});

test('parseWatermarkRegression: returns null when watermark missing or non-numeric', () => {
  expect(
    parseWatermarkRegression(
      JSON.stringify({ error: 'watermark_regression', current_server_watermark_end: 'x' }),
    ),
  ).toBe(null);
  expect(parseWatermarkRegression(JSON.stringify({ error: 'watermark_regression' }))).toBe(null);
});

test('parseWatermarkRegression: returns null when source_path_hash missing or empty', () => {
  expect(
    parseWatermarkRegression(
      JSON.stringify({
        error: 'watermark_regression',
        current_server_watermark_end: 100,
        source_path_hash: '',
      }),
    ),
  ).toBe(null);
  expect(
    parseWatermarkRegression(
      JSON.stringify({
        error: 'watermark_regression',
        current_server_watermark_end: 100,
      }),
    ),
  ).toBe(null);
});

test('parseWatermarkRegression: parses well-formed payload', () => {
  expect(
    parseWatermarkRegression(
      JSON.stringify({
        error: 'watermark_regression',
        current_server_watermark_end: 1024,
        source_path_hash: 'a'.repeat(64),
      }),
    ),
  ).toEqual({ currentServerWatermarkEnd: 1024, sourcePathHash: 'a'.repeat(64) });
});

test('parseServerWatermark: returns null for non-object', () => {
  expect(parseServerWatermark(null)).toBe(null);
  expect(parseServerWatermark('plain')).toBe(null);
  expect(parseServerWatermark(42)).toBe(null);
});

test('parseServerWatermark: returns null when required fields missing', () => {
  expect(parseServerWatermark({ source_app: 'codex' })).toBe(null);
});

test('parseServerWatermark: returns null when watermark_kind invalid', () => {
  expect(
    parseServerWatermark({
      source_app: 'codex',
      source_path_hash: 'h',
      watermark_kind: 'invalid_kind',
      watermark_end: 1,
      last_delivered_at: 't',
    }),
  ).toBe(null);
});

test('parseServerWatermark: parses byte_range with null watermark_table', () => {
  expect(
    parseServerWatermark({
      source_app: 'cursor',
      source_path_hash: 'hash',
      watermark_kind: 'byte_range',
      watermark_end: 100,
      watermark_table: null,
      last_delivered_at: '2026-05-08T00:00:00Z',
    }),
  ).toEqual({
    sourceApp: 'cursor',
    sourcePathHash: 'hash',
    watermarkKind: 'byte_range',
    watermarkEnd: 100,
    watermarkTable: null,
    lastDeliveredAt: '2026-05-08T00:00:00Z',
  });
});

test('parseServerWatermark: parses rowid_range with string watermark_table', () => {
  expect(
    parseServerWatermark({
      source_app: 'codex',
      source_path_hash: 'h',
      watermark_kind: 'rowid_range',
      watermark_end: 5,
      watermark_table: 'threads',
      last_delivered_at: '2026-05-08T00:00:00Z',
    }),
  ).toEqual({
    sourceApp: 'codex',
    sourcePathHash: 'h',
    watermarkKind: 'rowid_range',
    watermarkEnd: 5,
    watermarkTable: 'threads',
    lastDeliveredAt: '2026-05-08T00:00:00Z',
  });
});

test('parseServerWatermark: watermark_table coerced to null when non-string', () => {
  expect(
    parseServerWatermark({
      source_app: 'codex',
      source_path_hash: 'h',
      watermark_kind: 'rowid_range',
      watermark_end: 5,
      watermark_table: 42,
      last_delivered_at: 't',
    }),
  ).toEqual({
    sourceApp: 'codex',
    sourcePathHash: 'h',
    watermarkKind: 'rowid_range',
    watermarkEnd: 5,
    watermarkTable: null,
    lastDeliveredAt: 't',
  });
});
