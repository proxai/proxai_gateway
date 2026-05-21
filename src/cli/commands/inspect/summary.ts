import type {
  InspectSummary,
  SourceResult,
  SourceWarning,
} from 'cli/commands/inspect/inspect.types.ts';

export function aggregateResults(results: readonly SourceResult[]): InspectSummary {
  let totalFiles = 0;
  let totalRecords = 0;
  let totalTelemetryRecords = 0;
  let totalPrompts = 0;
  let totalBytes = 0;
  let totalRawBytes = 0;
  let totalCompressedBytes = 0;
  let oldestMs = Infinity;
  let oldestSource = '';
  let newestMs = -Infinity;
  let newestSource = '';

  for (const r of results) {
    totalFiles += r.filesProcessed;
    totalRecords += r.recordCount;
    totalTelemetryRecords += r.telemetryRecordCount;
    totalPrompts += r.promptCount;
    totalBytes += r.totalBytes;
    totalRawBytes += r.telemetryRawBytes;
    totalCompressedBytes += r.telemetryCompressedBytes;
    if (r.oldestDate !== null) {
      const ms = Date.parse(r.oldestDate);
      if (Number.isFinite(ms) && ms < oldestMs) {
        oldestMs = ms;
        oldestSource = r.sourceName;
      }
    }
    if (r.newestDate !== null) {
      const ms = Date.parse(r.newestDate);
      if (Number.isFinite(ms) && ms > newestMs) {
        newestMs = ms;
        newestSource = r.sourceName;
      }
    }
  }

  return {
    totalFiles,
    totalRecords,
    totalTelemetryRecords,
    totalPrompts,
    totalBytes,
    totalRawBytes,
    totalCompressedBytes,
    oldestDateIso: oldestMs === Infinity ? null : new Date(oldestMs).toISOString(),
    oldestSource,
    newestDateIso: newestMs === -Infinity ? null : new Date(newestMs).toISOString(),
    newestSource,
  };
}

export function collectWarnings(results: readonly SourceResult[]): SourceWarning[] {
  return results.flatMap((r) => r.errors.map((message) => ({ source: r.sourceName, message })));
}
