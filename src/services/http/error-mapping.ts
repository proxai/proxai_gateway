import {
  AuthError,
  FatalError,
  parseRetryAfter,
  RateLimitError,
  RetriableError,
  ValidationError,
  WatermarkRegressionError,
} from 'core/utils';

import { makeHttpContext, withCtx } from 'services/http/http-context.ts';
import { HEADER_RETRY_AFTER, HTTP_STATUS } from 'services/http/http.constants.ts';
import { parseWatermarkRegression } from 'services/http/parse-helpers.ts';

export async function dispatchSuccessOrThrow<T>(
  response: Response,
  url: string,
  method: string,
): Promise<T> {
  const status = response.status;
  if (status === HTTP_STATUS.ok || status === HTTP_STATUS.created) {
    const text = await response.text();
    if (text.length === 0) {
      throw withCtx(
        new FatalError(`server returned ${status.toString()} with empty body`),
        makeHttpContext(url, method, status, ''),
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw withCtx(
        new FatalError(`failed to parse response JSON: ${(err as Error).message}`, err),
        makeHttpContext(url, method, status, text),
      );
    }
  }
  const errorBody = await response.text();
  const ctx = makeHttpContext(url, method, status, errorBody);
  if (status === HTTP_STATUS.badRequest) {
    const regression = parseWatermarkRegression(errorBody);
    if (regression !== null) {
      throw withCtx(
        new WatermarkRegressionError(
          `server reported watermark_regression at ${regression.currentServerWatermarkEnd.toString()}`,
          regression.currentServerWatermarkEnd,
          regression.sourcePathHash,
        ),
        ctx,
      );
    }
    throw withCtx(new ValidationError(`server returned 400 ${response.statusText}`), ctx);
  }
  if (status === HTTP_STATUS.unauthorized) {
    throw withCtx(new AuthError('server returned 401: gateway key missing or invalid'), ctx);
  }
  if (status === HTTP_STATUS.forbidden) {
    throw withCtx(
      new AuthError('server returned 403: host not authorized for this gateway key'),
      ctx,
    );
  }
  if (status === HTTP_STATUS.requestTimeout) {
    throw withCtx(
      new ValidationError('server returned 408 (decompress timeout — gateway bug)'),
      ctx,
    );
  }
  if (status === HTTP_STATUS.payloadTooLarge) {
    throw withCtx(new ValidationError('server returned 413 (payload too large)'), ctx);
  }
  if (status === HTTP_STATUS.tooManyRequests) {
    const retryAfter = parseRetryAfter(response.headers.get(HEADER_RETRY_AFTER));
    throw withCtx(new RateLimitError('server returned 429 (rate limit)', retryAfter), ctx);
  }
  if (status >= 500 && status < 600) {
    const retryAfter = parseRetryAfter(response.headers.get(HEADER_RETRY_AFTER));
    throw withCtx(new RetriableError(`server returned ${status.toString()}`, retryAfter), ctx);
  }
  throw withCtx(new FatalError(`unexpected status: ${status.toString()}`), ctx);
}
