export interface HttpEndpoints {
  ingest: string;
  health: string;
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

export interface HealthResult {
  status: 'healthy' | 'unhealthy';
  checks: Record<string, boolean>;
}
