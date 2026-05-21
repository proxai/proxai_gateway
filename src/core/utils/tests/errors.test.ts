import { expect, test } from 'bun:test';
import {
  GatewayError,
  ValidationError,
  AuthError,
  RateLimitError,
  RetriableError,
  NetworkError,
  FatalError,
  UserAbortedError,
  WatermarkRegressionError,
  OversizedDecompressedSliceError,
} from '../errors.ts';

test('GatewayError and subclasses behave correctly', () => {
  const cause = new Error('nested');
  const gwErr = new GatewayError('fatal', 'something failed', cause);
  expect(gwErr.message).toBe('something failed');
  expect(gwErr.category).toBe('fatal');
  expect(gwErr.cause).toBe(cause);
  expect(gwErr.name).toBe('GatewayError');

  const ctx = {
    url: 'https://api.proxai.co/v1/ingest',
    method: 'POST',
    status: 400,
    bodyExcerpt: 'bad payload',
  };
  gwErr.withHttpContext(ctx);
  expect(gwErr.httpContext).toEqual(ctx);

  const valErr = new ValidationError('invalid DTO');
  expect(valErr.category).toBe('validation');

  const authErr = new AuthError('invalid key');
  expect(authErr.category).toBe('auth');

  const rlErr = new RateLimitError('rate limit hit', 5000);
  expect(rlErr.category).toBe('rate-limit');
  expect(rlErr.retryAfterMs).toBe(5000);

  const retErr = new RetriableError('retriable error', 1000);
  expect(retErr.category).toBe('retriable');
  expect(retErr.retryAfterMs).toBe(1000);

  const netErr = new NetworkError('disconnected');
  expect(netErr.category).toBe('network');

  const fatErr = new FatalError('fatal crash');
  expect(fatErr.category).toBe('fatal');

  const abortErr = new UserAbortedError();
  expect(abortErr.message).toBe('aborted by user');
  expect(abortErr.name).toBe('UserAbortedError');

  const regErr = new WatermarkRegressionError('regression', 100, 'hash123');
  expect(regErr.message).toBe('regression');
  expect(regErr.currentServerWatermarkEnd).toBe(100);
  expect(regErr.sourcePathHash).toBe('hash123');

  const details = {
    sourcePath: '/path/to/log.jsonl',
    sourcePathHash: 'hash123',
    rawBytes: 5000,
    compressedBytes: 500,
    sliceIndex: 1,
    cap: 4000,
  };
  const osErr = new OversizedDecompressedSliceError(details);
  expect(osErr.message).toContain('exceeds cap');
  expect(osErr.sourcePath).toBe('/path/to/log.jsonl');
  expect(osErr.sourcePathHash).toBe('hash123');
  expect(osErr.rawBytes).toBe(5000);
  expect(osErr.compressedBytes).toBe(500);
  expect(osErr.sliceIndex).toBe(1);
  expect(osErr.cap).toBe(4000);
});
