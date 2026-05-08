import type { ErrorCategory } from 'core/utils/utils.types.ts';

export interface HttpRequestContext {
  url: string;
  method: string;
  status: number | null;
  bodyExcerpt: string | null;
}

export class GatewayError extends Error {
  readonly category: ErrorCategory;
  override readonly cause: unknown;
  httpContext?: HttpRequestContext;

  constructor(category: ErrorCategory, message: string, cause?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.category = category;
    this.cause = cause;
  }

  withHttpContext(context: HttpRequestContext): this {
    this.httpContext = context;
    return this;
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
  readonly retryAfterMs: number | null;
  constructor(message: string, retryAfterMs: number | null = null, cause?: unknown) {
    super('retriable', message, cause);
    this.retryAfterMs = retryAfterMs;
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

export class WatermarkRegressionError extends ValidationError {
  readonly currentServerWatermarkEnd: number;
  readonly sourcePathHash: string;
  constructor(
    message: string,
    currentServerWatermarkEnd: number,
    sourcePathHash: string,
    cause?: unknown,
  ) {
    super(message, cause);
    this.currentServerWatermarkEnd = currentServerWatermarkEnd;
    this.sourcePathHash = sourcePathHash;
  }
}

export interface OversizedDecompressedSliceErrorDetails {
  sourcePath: string;
  sourcePathHash: string;
  rawBytes: number;
  compressedBytes: number;
  sliceIndex: number;
  cap: number;
}

export class OversizedDecompressedSliceError extends ValidationError {
  readonly sourcePath: string;
  readonly sourcePathHash: string;
  readonly rawBytes: number;
  readonly compressedBytes: number;
  readonly sliceIndex: number;
  readonly cap: number;

  constructor(details: OversizedDecompressedSliceErrorDetails, cause?: unknown) {
    super(
      `decompressed slice ${details.rawBytes.toString()} bytes exceeds cap ${details.cap.toString()} bytes (compressed=${details.compressedBytes.toString()}, slice_index=${details.sliceIndex.toString()}, source_path_hash=${details.sourcePathHash})`,
      cause,
    );
    this.sourcePath = details.sourcePath;
    this.sourcePathHash = details.sourcePathHash;
    this.rawBytes = details.rawBytes;
    this.compressedBytes = details.compressedBytes;
    this.sliceIndex = details.sliceIndex;
    this.cap = details.cap;
  }
}
