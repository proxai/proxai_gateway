export interface HttpEndpoints {
  ingest: string;
  authValidate: string;
  health: string;
  latestVersion: string;
  allowedHosts: string;
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
  method: 'GET' | 'POST' | 'PATCH';
  url: string;
  body?: unknown;
}

export interface UploadResult {
  captureId: string;
  accepted: boolean;
  idempotent: boolean;
}

export interface ValidateApiKeyResult {
  valid: boolean;
  accountEmail: string | null;
  error: string | null;
}

export interface PinAllowedHostResult {
  allowedHostIds: string[];
}

export interface HealthResult {
  ok: boolean;
  version: string;
}

export interface LatestVersionResult {
  latestVersion: string;
  releaseDate: string;
}
