export interface HttpEndpoints {
  ingest: string;
  verifyKey: string;
  watermarks: string;
}

export interface HttpClientOptions {
  apiKey: string;
  hostId: string;
  endpoints: HttpEndpoints;
  gatewayVersion?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export interface RequestOptions {
  method: 'GET' | 'POST';
  url: string;
  body?: unknown;
  withApiKey?: boolean;
}

export interface UploadResult {
  captureId: string;
  accepted: boolean;
  idempotent: boolean;
}

export interface VerifyKeyResult {
  success: boolean;
  message: string;
  userId: string | null;
  keyName: string | null;
}

export interface ServerWatermark {
  sourceApp: string;
  sourcePathHash: string;
  watermarkKind: 'byte_range' | 'rowid_range';
  watermarkEnd: number;
  watermarkTable: string | null;
  lastDeliveredAt: string;
}

export interface FetchWatermarksResult {
  hostId: string;
  userId: string;
  watermarks: readonly ServerWatermark[];
}
