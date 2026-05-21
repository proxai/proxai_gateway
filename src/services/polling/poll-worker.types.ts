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
    oldestDate: string | null;
  };
  captureResult?: {
    filesProcessed: number;
    capturedBytes: number;
    batches: Array<{
      captureId: string;
      sourceApp: string;
      sourceKind: string;
      sourcePath: string;
      sourcePathHash: string;
      sourceInode: number | null;
      watermarkKind: string;
      watermarkStart: number;
      watermarkEnd: number;
      watermarkTable: string | null;
      agentSchemaVersion: string;
      gatewayVersion: string;
      capturedAtUtc: string;
      bodyFormat: string;
      bodyCompression: string;
      body: Uint8Array;
    }>;
    quarantine: Array<{
      sourceApp: string;
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
