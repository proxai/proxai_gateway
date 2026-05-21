import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildMarkdownReport,
  resolveReportDir,
  resolveReportPath,
  writeMarkdownReport,
} from 'cli/commands/inspect/report.ts';
import type { InspectSummary, SourceResult } from 'cli/commands/inspect/inspect.types.ts';

function makeResult(over: Partial<SourceResult> = {}): SourceResult {
  return {
    sourceName: 'gemini-cli',
    filesProcessed: 3,
    recordCount: 30,
    totalBytes: 9000,
    telemetryRawBytes: 6000,
    telemetryCompressedBytes: 500,
    telemetryRecordCount: 12,
    promptCount: 4,
    oldestDate: '2026-05-02T00:00:00.000Z',
    newestDate: '2026-05-09T00:00:00.000Z',
    errors: [],
    ...over,
  };
}

function makeSummary(over: Partial<InspectSummary> = {}): InspectSummary {
  return {
    totalFiles: 3,
    totalRecords: 30,
    totalTelemetryRecords: 12,
    totalPrompts: 4,
    totalBytes: 9000,
    totalRawBytes: 6000,
    totalCompressedBytes: 500,
    oldestDateIso: '2026-05-02T00:00:00.000Z',
    oldestSource: 'gemini-cli',
    newestDateIso: '2026-05-09T00:00:00.000Z',
    newestSource: 'gemini-cli',
    ...over,
  };
}

test('resolveReportDir and resolveReportPath', () => {
  expect(resolveReportDir().length).toBeGreaterThan(0);
  const path = resolveReportPath(new Date('2026-05-21T10:30:45.000Z'));
  expect(path).toContain('inspect_2026-05-21T10-30-45.000Z.md');
});

test('buildMarkdownReport: renders all sections with results and warnings', () => {
  const markdown = buildMarkdownReport({
    results: [makeResult()],
    summary: makeSummary(),
    warnings: [{ source: 'cursor', message: 'boom' }],
    durationMs: 12.34,
    now: new Date('2026-05-21T10:00:00.000Z'),
  });
  expect(markdown).toContain('# ProxAI Telemetry Inspection Report');
  expect(markdown).toContain('Telemetry Sources on Disk');
  expect(markdown).toContain('Estimated Upload Metrics');
  expect(markdown).toContain('## ⚠ Warnings');
  expect(markdown).toContain('boom');
  expect(markdown).toContain('Gemini CLI');
});

test('buildMarkdownReport: omits warnings and handles null dates', () => {
  const markdown = buildMarkdownReport({
    results: [makeResult({ oldestDate: null })],
    summary: makeSummary({ oldestDateIso: null, newestDateIso: null }),
    warnings: [],
    durationMs: 1,
    now: new Date('2026-05-21T10:00:00.000Z'),
  });
  expect(markdown).toContain('None found');
  expect(markdown).not.toContain('## ⚠ Warnings');
});

test('writeMarkdownReport: creates the directory and writes the file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'proxai-inspect-report-'));
  try {
    const path = join(dir, 'nested', 'report.md');
    await writeMarkdownReport(path, 'hello report');
    expect(await readFile(path, 'utf-8')).toBe('hello report');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
