import { NetworkError, RetriableError } from 'core/utils';
import type { FetchFn } from 'core/utils';
import { validateRawRecordDTO } from 'services/contract';
import type { RawRecordDTO } from 'services/contract';

import { dispatchSuccessOrThrow } from 'services/http/error-mapping.ts';
import { makeHttpContext, withCtx } from 'services/http/http-context.ts';
import {
  CONTENT_TYPE_JSON,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
  HEADER_CONTENT_TYPE,
  HEADER_USER_AGENT,
  HEADER_X_API_KEY,
  HEADER_X_CLIENT_TIMEZONE,
  UPLOAD_TIMEOUT_MS,
} from 'services/http/http.constants.ts';
import type {
  FetchWatermarksResult,
  HttpClientOptions,
  HttpEndpoints,
  RegisterHostIdResult,
  RequestOptions,
  ServerWatermark,
  UploadResult,
  VerifyKeyResult,
} from 'services/http/http.types.ts';
import { parseServerWatermark } from 'services/http/parse-helpers.ts';

export class HttpClient {
  private readonly apiKey: string;
  private readonly hostId: string;
  private readonly endpoints: HttpEndpoints;
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private readonly fetchFn: FetchFn;

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

  async registerHostId(): Promise<RegisterHostIdResult> {
    const raw = await this.request<{
      host_id?: unknown;
      user_id?: unknown;
      registered?: unknown;
    }>({
      method: 'POST',
      url: this.endpoints.registerHostId,
      body: { host_id: this.hostId },
      withApiKey: true,
    });
    const hostId = typeof raw.host_id === 'string' ? raw.host_id : '';
    const userId = typeof raw.user_id === 'string' ? raw.user_id : '';
    const registered = raw.registered === true;
    return { hostId, userId, registered };
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
      withClientTimezone: true,
      timeoutMs: UPLOAD_TIMEOUT_MS,
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
    if (options.withClientTimezone === true) {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (tz) headers[HEADER_X_CLIENT_TIMEZONE] = tz;
    }
    let body: string | undefined;
    if (options.body !== undefined) {
      headers[HEADER_CONTENT_TYPE] = CONTENT_TYPE_JSON;
      body = JSON.stringify(options.body);
    }

    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const init: RequestInit = {
      method: options.method,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      ...(body !== undefined ? { body } : {}),
    };

    let response: Response;
    try {
      response = await this.fetchFn(options.url, init);
    } catch (err: unknown) {
      const e = err as Error;
      const ctx = makeHttpContext(options.url, options.method, null, null);
      if (e.name === 'TimeoutError' || e.name === 'AbortError') {
        throw withCtx(
          new RetriableError(`request timed out after ${timeoutMs.toString()}ms`, null, err),
          ctx,
        );
      }
      throw withCtx(new NetworkError(`network failure: ${e.message}`, err), ctx);
    }

    return dispatchSuccessOrThrow<T>(response, options.url, options.method);
  }
}
