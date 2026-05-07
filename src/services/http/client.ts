import {
  AuthError,
  FatalError,
  NetworkError,
  parseRetryAfter,
  RateLimitError,
  RetriableError,
  ValidationError,
  WatermarkRegressionError,
} from 'core/utils';
import { validateRawRecordDTO } from 'services/contract';
import type { RawRecordDTO } from 'services/contract';
import {
  CONTENT_TYPE_JSON,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
  HEADER_CONTENT_TYPE,
  HEADER_RETRY_AFTER,
  HEADER_USER_AGENT,
  HEADER_X_API_KEY,
  HTTP_STATUS,
} from 'services/http/http.constants.ts';
import type {
  FetchWatermarksResult,
  HttpClientOptions,
  HttpEndpoints,
  RequestOptions,
  ServerWatermark,
  UploadResult,
  VerifyKeyResult,
} from 'services/http/http.types.ts';

export class HttpClient {
  private readonly apiKey: string;
  private readonly hostId: string;
  private readonly endpoints: HttpEndpoints;
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private readonly fetchFn: typeof globalThis.fetch;

  constructor(options: HttpClientOptions) {
    this.apiKey = options.apiKey;
    this.hostId = options.hostId;
    this.endpoints = options.endpoints;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.userAgent = options.gatewayVersion ?? DEFAULT_USER_AGENT;
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  get hostIdentifier(): string {
    return this.hostId;
  }

  async verifyKey(): Promise<VerifyKeyResult> {
    const raw = await this.request<{
      success: boolean;
      message?: string;
      data?: { userId?: unknown; keyName?: unknown } | null;
    }>({
      method: 'GET',
      url: this.endpoints.verifyKey,
      withApiKey: true,
    });
    const data = raw.data;
    const userId =
      data !== null && data !== undefined && typeof data.userId === 'string' ? data.userId : null;
    const keyName =
      data !== null && data !== undefined && typeof data.keyName === 'string' ? data.keyName : null;
    return {
      success: raw.success === true,
      message: raw.message ?? '',
      userId,
      keyName,
    };
  }

  async fetchWatermarks(): Promise<FetchWatermarksResult> {
    const url = `${this.endpoints.watermarks}?host_id=${encodeURIComponent(this.hostId)}`;
    const raw = await this.request<{
      host_id?: unknown;
      user_id?: unknown;
      watermarks?: unknown;
    }>({
      method: 'GET',
      url,
      withApiKey: true,
    });
    const hostId = typeof raw.host_id === 'string' ? raw.host_id : '';
    const userId = typeof raw.user_id === 'string' ? raw.user_id : '';
    const watermarks: ServerWatermark[] = [];
    if (Array.isArray(raw.watermarks)) {
      for (const item of raw.watermarks) {
        const parsed = parseServerWatermark(item);
        if (parsed !== null) watermarks.push(parsed);
      }
    }
    return { hostId, userId, watermarks };
  }

  async uploadRawRecord(dto: RawRecordDTO): Promise<UploadResult> {
    validateRawRecordDTO(dto);
    const raw = await this.request<{
      capture_id: string;
      accepted: boolean;
      idempotent: boolean;
    }>({
      method: 'POST',
      url: this.endpoints.ingest,
      body: dto,
      withApiKey: true,
    });
    return {
      captureId: raw.capture_id,
      accepted: raw.accepted,
      idempotent: raw.idempotent,
    };
  }

  private async request<T>(options: RequestOptions): Promise<T> {
    const headers: Record<string, string> = {
      [HEADER_USER_AGENT]: this.userAgent,
    };
    if (options.withApiKey === true) {
      headers[HEADER_X_API_KEY] = this.apiKey;
    }
    let body: string | undefined;
    if (options.body !== undefined) {
      headers[HEADER_CONTENT_TYPE] = CONTENT_TYPE_JSON;
      body = JSON.stringify(options.body);
    }

    const init: RequestInit = {
      method: options.method,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
      ...(body !== undefined ? { body } : {}),
    };

    let response: Response;
    try {
      response = await this.fetchFn(options.url, init);
    } catch (err: unknown) {
      const e = err as Error;
      if (e.name === 'TimeoutError' || e.name === 'AbortError') {
        throw new RetriableError(
          `request timed out after ${this.timeoutMs.toString()}ms`,
          null,
          err,
        );
      }
      throw new NetworkError(`network failure: ${e.message}`, err);
    }

    return this.dispatch<T>(response);
  }

  private async dispatch<T>(response: Response): Promise<T> {
    const status = response.status;

    if (status === HTTP_STATUS.ok || status === HTTP_STATUS.created) {
      const text = await response.text();
      if (text.length === 0) {
        throw new FatalError(`server returned ${status.toString()} with empty body`);
      }
      try {
        return JSON.parse(text) as T;
      } catch (err) {
        throw new FatalError(`failed to parse response JSON: ${(err as Error).message}`, err);
      }
    }
    if (status === HTTP_STATUS.badRequest) {
      const text = await response.text();
      const regression = parseWatermarkRegression(text);
      if (regression !== null) {
        throw new WatermarkRegressionError(
          `server reported watermark_regression at ${regression.currentServerWatermarkEnd.toString()}`,
          regression.currentServerWatermarkEnd,
          regression.sourcePathHash,
        );
      }
      throw new ValidationError(`server returned 400 ${response.statusText}`);
    }
    if (status === HTTP_STATUS.unauthorized) {
      throw new AuthError('server returned 401: ingestion key missing or invalid');
    }
    if (status === HTTP_STATUS.forbidden) {
      throw new AuthError('server returned 403: ingestion key invalid or revoked');
    }
    if (status === HTTP_STATUS.requestTimeout) {
      throw new ValidationError('server returned 408 (decompress timeout — gateway bug)');
    }
    if (status === HTTP_STATUS.payloadTooLarge) {
      throw new ValidationError('server returned 413 (payload too large)');
    }
    if (status === HTTP_STATUS.tooManyRequests) {
      const retryAfter = parseRetryAfter(response.headers.get(HEADER_RETRY_AFTER));
      throw new RateLimitError('server returned 429 (rate limit)', retryAfter);
    }
    if (status >= 500 && status < 600) {
      // Honor Retry-After on 5xx (nest emits this when parse-queue
      // backpressure trips the high-water mark on 503). Carries through to
      // the pacer's notifyServiceUnavailable path.
      const retryAfter = parseRetryAfter(response.headers.get(HEADER_RETRY_AFTER));
      throw new RetriableError(`server returned ${status.toString()}`, retryAfter);
    }
    throw new FatalError(`unexpected status: ${status.toString()}`);
  }
}

function parseWatermarkRegression(
  text: string,
): { currentServerWatermarkEnd: number; sourcePathHash: string } | null {
  if (text.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const r = parsed as Record<string, unknown>;
  if (r['error'] !== 'watermark_regression') return null;
  const watermark = r['current_server_watermark_end'];
  const hash = r['source_path_hash'];
  if (typeof watermark !== 'number' || !Number.isFinite(watermark)) return null;
  if (typeof hash !== 'string' || hash.length === 0) return null;
  return { currentServerWatermarkEnd: watermark, sourcePathHash: hash };
}

function parseServerWatermark(item: unknown): ServerWatermark | null {
  if (item === null || typeof item !== 'object') return null;
  const r = item as Record<string, unknown>;
  const sourceApp = typeof r['source_app'] === 'string' ? r['source_app'] : null;
  const sourcePathHash = typeof r['source_path_hash'] === 'string' ? r['source_path_hash'] : null;
  const watermarkKindRaw = typeof r['watermark_kind'] === 'string' ? r['watermark_kind'] : null;
  const watermarkEnd = typeof r['watermark_end'] === 'number' ? r['watermark_end'] : null;
  const watermarkTableRaw = r['watermark_table'];
  const watermarkTable =
    watermarkTableRaw === null || watermarkTableRaw === undefined
      ? null
      : typeof watermarkTableRaw === 'string'
        ? watermarkTableRaw
        : null;
  const lastDeliveredAt =
    typeof r['last_delivered_at'] === 'string' ? r['last_delivered_at'] : null;

  if (
    sourceApp === null ||
    sourcePathHash === null ||
    watermarkKindRaw === null ||
    watermarkEnd === null ||
    lastDeliveredAt === null
  ) {
    return null;
  }
  if (watermarkKindRaw !== 'byte_range' && watermarkKindRaw !== 'rowid_range') {
    return null;
  }
  return {
    sourceApp,
    sourcePathHash,
    watermarkKind: watermarkKindRaw,
    watermarkEnd,
    watermarkTable,
    lastDeliveredAt,
  };
}
