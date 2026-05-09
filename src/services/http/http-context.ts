import type { GatewayError, HttpRequestContext } from 'core/utils';

const RESPONSE_BODY_EXCERPT_LIMIT = 512;

export function makeHttpContext(
  url: string,
  method: string,
  status: number | null,
  body: string | null,
): HttpRequestContext {
  let bodyExcerpt: string | null = null;
  if (body !== null) {
    bodyExcerpt =
      body.length > RESPONSE_BODY_EXCERPT_LIMIT
        ? `${body.slice(0, RESPONSE_BODY_EXCERPT_LIMIT)}…`
        : body;
  }
  return { url, method, status, bodyExcerpt };
}

export function withCtx<E extends GatewayError>(err: E, ctx: HttpRequestContext): E {
  err.withHttpContext(ctx);
  return err;
}
