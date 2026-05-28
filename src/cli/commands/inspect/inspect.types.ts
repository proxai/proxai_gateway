import type { OutputSink } from 'cli/cli.types.ts';

export interface InspectBaseDirs {
  claudeCode?: string;
  cursor?: string;
  geminiCli?: string;
  codex?: string;
  claudeDesktop?: string;
}

export interface InspectCommandDeps {
  output: OutputSink;
  configExists: () => Promise<boolean>;
  gatewayVersion: string;
}

export interface InspectCommandOptions {
  baseDirs?: InspectBaseDirs;
}

export interface SourceResult {
  sourceName: string;
  filesProcessed: number;
  recordCount: number;
  totalBytes: number;
  telemetryRawBytes: number;
  telemetryCompressedBytes: number;
  telemetryRecordCount: number;
  promptCount: number;
  oldestDate: string | null;
  newestDate: string | null;
  errors: string[];
}

export interface SourceWarning {
  source: string;
  message: string;
}

export interface InspectSummary {
  totalFiles: number;
  totalRecords: number;
  totalTelemetryRecords: number;
  totalPrompts: number;
  totalBytes: number;
  totalRawBytes: number;
  totalCompressedBytes: number;
  oldestDateIso: string | null;
  oldestSource: string;
  newestDateIso: string | null;
  newestSource: string;
}
