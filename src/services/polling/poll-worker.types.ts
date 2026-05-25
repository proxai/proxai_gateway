import type {
  BodyCompression,
  BodyFormat,
  SourceApp,
  SourceKind,
  WatermarkKind,
} from 'services/contract';

export interface WorkerInput {
  task: 'inspect' | 'capture';
  sourceName: string;
  options: {
    baseDir?: string;
    gatewayVersion: string;
    maxDecompressedBytes: number;
    captureSubAgents: boolean;
    priorCursors?: Array<{
      sourcePathHash: string;
      sourcePath: string;
      sourceInode: number | null;
      watermarkTable: string | null;
      watermarkEnd: number;
      lastSeenSizeBytes: number | null;
      lastSeenPageCount: number | null;
      consecutiveErrors?: number;
    }>;
  };
}

export interface WorkerOutput {
  sourceName: string;
  success: boolean;
  error?: string;
  inspectResult?: {
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
  };
  captureResult?: {
    filesProcessed: number;
    capturedBytes: number;
    batches: Array<{
      captureId: string;
      sourceApp: SourceApp;
      sourceKind: SourceKind;
      sourcePath: string;
      sourcePathHash: string;
      sourceInode: number | null;
      watermarkKind: WatermarkKind;
      watermarkStart: number;
      watermarkEnd: number;
      watermarkTable: string | null;
      agentSchemaVersion: string;
      gatewayVersion: string;
      capturedAtUtc: string;
      bodyFormat: BodyFormat;
      bodyCompression: BodyCompression;
      body: Uint8Array;
    }>;
    quarantine: Array<{
      sourceApp: SourceApp;
      sourcePath: string;
      sourcePathHash: string;
      sourceInode: number | null;
      watermarkTable: string | null;
      watermarkPosition: number;
      rowPk: string | null;
      redactedSizeBytes: number;
      reason: string;
      quarantinedAtUtc: string;
      gatewayVersion: string;
    }>;
    cursors: Array<{
      sourcePathHash: string;
      sourcePath: string;
      sourceInode: number | null;
      watermarkTable: string | null;
      watermarkEnd: number;
      lastSeenSizeBytes: number | null;
      lastSeenPageCount: number | null;
      consecutiveErrors: number;
    }>;
  };
}
