import {
  AuthError,
  FatalError,
  NetworkError,
  parseRetryAfter,
  RateLimitError,
  RetriableError,
  ValidationError,
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
  HttpClientOptions,
  HttpEndpoints,
  RequestOptions,
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
        throw new RetriableError(`request timed out after ${this.timeoutMs.toString()}ms`, err);
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
      throw new ValidationError(`server returned 400 ${response.statusText}`);
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
      throw new RetriableError(`server returned ${status.toString()}`);
    }
    throw new FatalError(`unexpected status: ${status.toString()}`);
  }
}
