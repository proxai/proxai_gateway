export const HEADER_X_API_KEY = 'X-API-Key';
export const HEADER_X_CLIENT_TIMEZONE = 'X-Client-Timezone';
export const HEADER_CONTENT_TYPE = 'Content-Type';
export const HEADER_RETRY_AFTER = 'Retry-After';
export const HEADER_USER_AGENT = 'User-Agent';

export const CONTENT_TYPE_JSON = 'application/json';

export const DEFAULT_TIMEOUT_MS = 30_000;
export const UPLOAD_TIMEOUT_MS = 60_000;

export const DEFAULT_USER_AGENT = '@proxai/gateway';

export const HTTP_STATUS = {
  ok: 200,
  created: 201,
  badRequest: 400,
  unauthorized: 401,
  forbidden: 403,
  requestTimeout: 408,
  payloadTooLarge: 413,
  tooManyRequests: 429,
  serviceUnavailable: 503,
} as const;
