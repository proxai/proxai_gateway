import { expect, test } from 'bun:test';

import {
  formatCell,
  formatDiskRow,
  formatRatio,
  formatTitle,
  formatUploadRow,
  renderDiskTable,
  renderHighlights,
  renderUploadTable,
  renderWarnings,
  scaleSegments,
  tableDivider,
} from 'cli/commands/inspect/layout.ts';
import type { InspectSummary, SourceResult } from 'cli/commands/inspect/inspect.types.ts';

function makeResult(over: Partial<SourceResult> = {}): SourceResult {
  return {
    sourceName: 'claude-code',
    filesProcessed: 1,
    recordCount: 10,
    totalBytes: 1000,
    telemetryRawBytes: 600,
    telemetryCompressedBytes: 100,
    telemetryRecordCount: 5,
    promptCount: 2,
    oldestDate: '2026-05-01T00:00:00.000Z',
    newestDate: '2026-05-10T00:00:00.000Z',
    errors: [],
    ...over,
  };
}

function makeSummary(over: Partial<InspectSummary> = {}): InspectSummary {
  return {
    totalFiles: 1,
    totalRecords: 10,
    totalTelemetryRecords: 5,
    totalPrompts: 2,
    totalBytes: 1000,
    totalRawBytes: 600,
    totalCompressedBytes: 100,
    oldestDateIso: '2026-05-01T00:00:00.000Z',
    oldestSource: 'claude-code',
    newestDateIso: '2026-05-10T00:00:00.000Z',
    newestSource: 'claude-code',
    ...over,
  };
}

test('formatRatio: computes a ratio or falls back', () => {
  expect(formatRatio(600, 100)).toBe('6.0');
  expect(formatRatio(1000, 40)).toBe('25.0');
  expect(formatRatio(0, 0)).toBe('6.0');
  expect(formatRatio(500, 0)).toBe('6.0');
});

test('tableDivider: joins segment widths', () => {
  expect(tableDivider([2, 3], '├', '┼', '┤')).toBe('├──┼───┤');
});

test('formatDiskRow: header, total and normal styles', () => {
  expect(formatDiskRow('Source', 'F', 'P', 'E', 'S', 'O', { isHeader: true })).toContain('Source');
  expect(formatDiskRow('TOTAL', 'F', 'P', 'E', 'S', 'O', { isTotal: true })).toContain('TOTAL');
  expect(formatDiskRow('Codex', 'F', 'P', 'E', 'S', 'O')).toContain('Codex');
});

test('formatUploadRow: header, total and normal styles', () => {
  expect(formatUploadRow('Source', 'P', 'E', 'U', 'S', { isHeader: true })).toContain('Source');
  expect(formatUploadRow('TOTAL', 'P', 'E', 'U', 'S', { isTotal: true })).toContain('TOTAL');
  expect(formatUploadRow('Codex', 'P', 'E', 'U', 'S')).toContain('Codex');
});

test('renderDiskTable: title, rows and total', () => {
  const lines = renderDiskTable([makeResult(), makeResult({ oldestDate: null })], makeSummary());
  expect(lines.some((l) => l.includes('TELEMETRY SOURCES ON DISK'))).toBe(true);
  expect(lines.some((l) => l.includes('Claude Code'))).toBe(true);
  expect(lines.some((l) => l.includes('TOTAL'))).toBe(true);
});

test('renderDiskTable: handles a null summary oldest date', () => {
  const lines = renderDiskTable([makeResult()], makeSummary({ oldestDateIso: null }));
  expect(lines.length).toBeGreaterThan(0);
});

test('renderUploadTable: title, rows and total', () => {
  const lines = renderUploadTable([makeResult()], makeSummary());
  expect(lines.some((l) => l.includes('ESTIMATED UPLOAD METRICS'))).toBe(true);
  expect(lines.some((l) => l.includes('TOTAL'))).toBe(true);
});

test('renderWarnings: empty and populated', () => {
  expect(renderWarnings([])).toEqual([]);
  const lines = renderWarnings([{ source: 'cursor', message: 'boom' }]);
  expect(lines.some((l) => l.includes('Warnings'))).toBe(true);
  expect(lines.some((l) => l.includes('boom'))).toBe(true);
});

test('renderHighlights: with dates and without', () => {
  const withDates = renderHighlights(makeSummary(), 12.5);
  expect(withDates.some((l) => l.includes('Oldest telemetry record'))).toBe(true);
  expect(withDates.some((l) => l.includes('Newest telemetry record'))).toBe(true);

  const noDates = renderHighlights(makeSummary({ oldestDateIso: null, newestDateIso: null }), 1);
  expect(noDates.some((l) => l.includes('No telemetry records found'))).toBe(true);
});

test('scaleSegments: handles proportional scaling', () => {
  const orig = [16, 10, 11, 14, 12, 10];

  expect(scaleSegments(orig, 80)).toEqual([...orig]);

  const scaled60 = scaleSegments(orig, 60);
  expect(scaled60.reduce((a, b) => a + b, 0)).toBe(53);
  expect(scaled60.every((w) => w >= 4)).toBe(true);

  const scaled20 = scaleSegments(orig, 20);
  expect(scaled20).toEqual([4, 4, 4, 4, 4, 4]);
});

test('formatCell: pads and truncates appropriately', () => {
  expect(formatCell('abc', 5, 'left')).toBe('abc  ');
  expect(formatCell('abc', 5, 'right')).toBe('  abc');
  expect(formatCell('abcdef', 5, 'left')).toBe('abcd…');
  expect(formatCell('abcdef', 5, 'right')).toBe('…cdef');
  expect(formatCell('abcdef', 3, 'left')).toBe('abc');
});

test('formatTitle: pads and truncates titles', () => {
  expect(formatTitle('Title', 10)).toBe('Title   ');
  expect(formatTitle('Very Long Title Indeed', 10)).toBe('Very Lo…');
});

test('renderDiskTable and renderUploadTable: respect responsive width', () => {
  const disk80 = renderDiskTable([makeResult()], makeSummary(), 80);
  expect((disk80[0] ?? '').includes('─'.repeat(78))).toBe(true);

  const disk60 = renderDiskTable([makeResult()], makeSummary(), 60);
  expect((disk60[0] ?? '').includes('─'.repeat(58))).toBe(true);

  const upload80 = renderUploadTable([makeResult()], makeSummary(), 80);
  expect((upload80[0] ?? '').includes('─'.repeat(78))).toBe(true);

  const upload60 = renderUploadTable([makeResult()], makeSummary(), 60);
  expect((upload60[0] ?? '').includes('─'.repeat(58))).toBe(true);
});
