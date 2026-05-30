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
  getTerminalWidth,
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

test('getTerminalWidth: works correctly', () => {
  const origCols = process.stdout.columns;
  try {
    Object.defineProperty(process.stdout, 'columns', { value: 120, configurable: true });
    expect(getTerminalWidth()).toBe(80);

    Object.defineProperty(process.stdout, 'columns', { value: 50, configurable: true });
    expect(getTerminalWidth()).toBe(50);

    Object.defineProperty(process.stdout, 'columns', { value: undefined, configurable: true });
    expect(getTerminalWidth()).toBe(80);
  } finally {
    Object.defineProperty(process.stdout, 'columns', { value: origCols, configurable: true });
  }
});

test('scaleSegments: targetSum <= 0 clamps to minWidth', () => {
  expect(scaleSegments([16, 10, 11, 14, 12, 10], 5)).toEqual([4, 4, 4, 4, 4, 4]);
});

test('scaleSegments: excess currentSum > targetSum is reduced correctly', () => {
  // originalSegments length = 3, targetTotalWidth = 15 => targetSum = 15 - 3 - 1 = 11.
  // orig = [10, 10, 10] -> floor(10 * (11 / 30)) = 3 -> max(4, 3) = 4 -> [4, 4, 4] -> sum = 12 > 11.
  // excess = 12 - 11 = 1. reduces one segment by 1 to yield sum of 11.
  // Wait, minWidth is 4. If all segments are at minWidth 4, they cannot be reduced below minWidth!
  // Let's design a test case where some segments are > minWidth, but the sum is still greater than targetSum!
  // E.g., originalSegments = [10, 10, 5], originalSum = 25.
  // targetTotalWidth = 16 => targetSum = 16 - 3 - 1 = 12.
  // orig[0] -> floor(10 * 12/25) = 4 -> max(4, 4) = 4
  // orig[1] -> floor(10 * 12/25) = 4 -> max(4, 4) = 4
  // orig[2] -> floor(5 * 12/25) = 2 -> max(4, 2) = 4
  // Clamped = [4, 4, 4], sum = 12 == targetSum.
  // What if targetTotalWidth = 15 => targetSum = 11.
  // Clamped still is [4, 4, 4] due to minWidth, sum = 12 > 11. But we can't reduce any because they are all at minWidth!
  // Let's choose: originalSegments = [20, 20, 5], originalSum = 45.
  // targetTotalWidth = 17 => targetSum = 13.
  // floor(20 * 13/45) = 5 -> max(4, 5) = 5
  // floor(20 * 13/45) = 5 -> max(4, 5) = 5
  // floor(5 * 13/45) = 1 -> max(4, 1) = 4
  // Clamped = [5, 5, 4], sum = 14 > 13.
  // excess = 1. Reduces first eligible segment by 1 (5 -> 4), resulting in [4, 5, 4] or [5, 4, 4], sum = 13.
  const orig = [20, 20, 5];
  const result = scaleSegments(orig, 17);
  expect(result.reduce((sum, val) => sum + val, 0)).toBe(13);
  expect(result.every((w) => w >= 4)).toBe(true);
});

test('formatTitle: handles title longer than targetLen when targetLen < 4', () => {
  expect(formatTitle('TitleText', 5)).toBe('Tit'); // targetLen = 5 - 2 = 3. 3 < 4, slices to title.slice(0, 3) -> 'Tit'
});

test('formatCell: handles string longer than width when width < 4', () => {
  expect(formatCell('abcdef', 3, 'right')).toBe('abc');
});
