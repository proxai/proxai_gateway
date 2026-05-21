import { expect, test } from 'bun:test';

import { aggregateResults, collectWarnings } from 'cli/commands/inspect/summary.ts';
import type { SourceResult } from 'cli/commands/inspect/inspect.types.ts';

function makeResult(over: Partial<SourceResult> = {}): SourceResult {
  return {
    sourceName: 'claude-code',
    filesProcessed: 0,
    recordCount: 0,
    totalBytes: 0,
    telemetryRawBytes: 0,
    telemetryCompressedBytes: 0,
    telemetryRecordCount: 0,
    promptCount: 0,
    oldestDate: null,
    newestDate: null,
    errors: [],
    ...over,
  };
}

test('aggregateResults: sums totals and resolves chronology', () => {
  const summary = aggregateResults([
    makeResult({
      sourceName: 'claude-code',
      filesProcessed: 2,
      recordCount: 10,
      totalBytes: 100,
      telemetryRawBytes: 50,
      telemetryCompressedBytes: 10,
      telemetryRecordCount: 5,
      promptCount: 4,
      oldestDate: '2026-05-10T00:00:00.000Z',
      newestDate: '2026-05-15T00:00:00.000Z',
    }),
    makeResult({
      sourceName: 'codex',
      filesProcessed: 1,
      recordCount: 4,
      totalBytes: 40,
      telemetryRawBytes: 20,
      telemetryCompressedBytes: 4,
      telemetryRecordCount: 2,
      promptCount: 1,
      oldestDate: '2026-05-01T00:00:00.000Z',
      newestDate: '2026-05-20T00:00:00.000Z',
    }),
  ]);
  expect(summary.totalFiles).toBe(3);
  expect(summary.totalRecords).toBe(14);
  expect(summary.totalTelemetryRecords).toBe(7);
  expect(summary.totalPrompts).toBe(5);
  expect(summary.totalBytes).toBe(140);
  expect(summary.totalRawBytes).toBe(70);
  expect(summary.totalCompressedBytes).toBe(14);
  expect(summary.oldestDateIso).toBe('2026-05-01T00:00:00.000Z');
  expect(summary.oldestSource).toBe('codex');
  expect(summary.newestDateIso).toBe('2026-05-20T00:00:00.000Z');
  expect(summary.newestSource).toBe('codex');
});

test('aggregateResults: ignores null and invalid dates', () => {
  const summary = aggregateResults([
    makeResult({ oldestDate: null, newestDate: null }),
    makeResult({ oldestDate: 'not-a-date', newestDate: 'also-bad' }),
  ]);
  expect(summary.oldestDateIso).toBeNull();
  expect(summary.newestDateIso).toBeNull();
  expect(summary.oldestSource).toBe('');
  expect(summary.newestSource).toBe('');
});

test('aggregateResults: handles empty input', () => {
  const summary = aggregateResults([]);
  expect(summary.totalFiles).toBe(0);
  expect(summary.oldestDateIso).toBeNull();
  expect(summary.newestDateIso).toBeNull();
});

test('collectWarnings: flattens per-source errors', () => {
  const warnings = collectWarnings([
    makeResult({ sourceName: 'cursor', errors: ['boom', 'bang'] }),
    makeResult({ sourceName: 'codex', errors: [] }),
  ]);
  expect(warnings).toEqual([
    { source: 'cursor', message: 'boom' },
    { source: 'cursor', message: 'bang' },
  ]);
});
