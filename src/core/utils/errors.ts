import type { ErrorCategory } from 'core/utils/utils.types.ts';

export class GatewayError extends Error {
  readonly category: ErrorCategory;
  override readonly cause: unknown;

  constructor(category: ErrorCategory, message: string, cause?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.category = category;
    this.cause = cause;
  }
}

export class ValidationError extends GatewayError {
  constructor(message: string, cause?: unknown) {
    super('validation', message, cause);
  }
}

export class AuthError extends GatewayError {
  constructor(message: string, cause?: unknown) {
    super('auth', message, cause);
  }
}

export class RateLimitError extends GatewayError {
  readonly retryAfterMs: number | null;
  constructor(message: string, retryAfterMs: number | null = null, cause?: unknown) {
    super('rate-limit', message, cause);
    this.retryAfterMs = retryAfterMs;
  }
}

export class RetriableError extends GatewayError {
  constructor(message: string, cause?: unknown) {
    super('retriable', message, cause);
  }
}

export class NetworkError extends GatewayError {
  constructor(message: string, cause?: unknown) {
    super('network', message, cause);
  }
}

export class FatalError extends GatewayError {
  constructor(message: string, cause?: unknown) {
    super('fatal', message, cause);
  }
}
