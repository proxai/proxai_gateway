import { expect, test } from 'bun:test';

import {
  colorForLevel,
  glyphForLevel,
  formatLocalDateTime,
  formatCount,
  formatByteCount,
  padLabel,
  dim,
  bold,
  cyan,
} from 'cli/commands/status/render/format-helpers.ts';

import {
  labelCol,
  rowCount,
  rowCountBytes,
  rowText,
  rowBytes,
  subRowCountBytes,
  sectionDivider,
} from 'cli/commands/status/render/format-rows.ts';

test('format-helpers colorForLevel and glyphForLevel', () => {
  expect(colorForLevel('ok')('test')).toContain('test');
  expect(colorForLevel('warning')('test')).toContain('test');
  expect(colorForLevel('error')('test')).toContain('test');
  expect(colorForLevel('inactive')('test')).toContain('test');
  expect(glyphForLevel('ok')).toBe('');
  expect(glyphForLevel('warning')).toBe('');
  expect(glyphForLevel('error')).toBe('');
  expect(glyphForLevel('inactive')).toBe('');
});

test('format-helpers formatLocalDateTime', () => {
  const d = new Date('2026-05-08T13:32:17Z');
  const formatted = formatLocalDateTime(d);
  expect(formatted).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test('format-helpers formatCount', () => {
  expect(formatCount(1234)).toBe('1,234');
});

test('format-helpers formatByteCount', () => {
  expect(formatByteCount(1024)).toBe('1.00 KB');
});

test('format-helpers padLabel', () => {
  expect(padLabel('a', 5)).toBe('a    ');
  expect(padLabel('abcde', 5)).toBe('abcde');
  expect(padLabel('abcdef', 5)).toBe('abcdef');
});

test('format-helpers dim, bold, cyan', () => {
  expect(dim('t')).toContain('t');
  expect(bold('t')).toContain('t');
  expect(cyan('t')).toContain('t');
});

test('format-rows labelCol', () => {
  expect(labelCol('t')).toHaveLength(16);
});

test('format-rows rowCount', () => {
  const r = rowCount('Pending', 5, 'records', 'comment');
  expect(r).toContain('Pending');
  expect(r).toContain('5');
  expect(r).toContain('records');
  expect(r).toContain('comment');
});

test('format-rows rowCountBytes', () => {
  const r = rowCountBytes('Pending', 5, 'records', 1024, 'comment');
  expect(r).toContain('Pending');
  expect(r).toContain('5');
  expect(r).toContain('1.00 KB');
  expect(r).toContain('comment');
});

test('format-rows rowText', () => {
  const r = rowText('Status', 'Ok', 'comment');
  expect(r).toContain('Status');
  expect(r).toContain('Ok');
  expect(r).toContain('comment');
});

test('format-rows rowBytes', () => {
  const r = rowBytes('Memory', 1024, 2048, 'comment');
  expect(r).toContain('Memory');
  expect(r).toContain('1.00 KB');
  expect(r).toContain('2.00 KB');
  expect(r).toContain('comment');
});

test('format-rows subRowCountBytes', () => {
  const r = subRowCountBytes('Cursor', 3, 'batches', 1024);
  expect(r).toContain('Cursor');
  expect(r).toContain('3');
  expect(r).toContain('batches');
  expect(r).toContain('1.00 KB');
});

test('format-rows sectionDivider', () => {
  const r1 = sectionDivider('Health');
  expect(r1).toContain('Health');
});
