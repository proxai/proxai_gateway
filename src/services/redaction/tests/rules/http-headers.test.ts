import { expect, test } from 'bun:test';

import { applyRedaction } from 'services/redaction';
import { HTTP_HEADERS_RULES } from 'services/redaction/rules/http-headers.ts';

test('redacts an Authorization Bearer header value', () => {
  const input = 'Authorization: Bearer abc123def456ghi789jkl012';
  const result = applyRedaction(input, HTTP_HEADERS_RULES);
  expect(result.redacted).toContain('[REDACTED:bearer]');
  expect(result.redacted.toLowerCase()).toContain('authorization: bearer');
});

test('redacts an Authorization Basic header value', () => {
  const input = 'Authorization: Basic dXNlcjpwYXNzd29yZA==';
  const result = applyRedaction(input, HTTP_HEADERS_RULES);
  expect(result.redacted).toContain('[REDACTED:basic]');
});

test('redacts an x-api-key header', () => {
  const input = 'x-api-key: 1234567890abcdef0123456789abcd';
  const result = applyRedaction(input, HTTP_HEADERS_RULES);
  expect(result.redacted).toContain('[REDACTED:api-key]');
});

test('redacts an api-key (no x prefix) header', () => {
  const input = 'api-key: 1234567890abcdef0123456789abcd';
  const result = applyRedaction(input, HTTP_HEADERS_RULES);
  expect(result.redacted).toContain('[REDACTED:api-key]');
});

test('does not match Authorization without Bearer or Basic prefix', () => {
  const input = 'Authorization: Custom xyz';
  const result = applyRedaction(input, HTTP_HEADERS_RULES);
  expect(result.redacted).toBe(input);
});

test('redacts an x-auth-token header value', () => {
  const input = 'x-auth-token: AbCdEfGhIjKlMnOpQrStUvWx';
  const result = applyRedaction(input, HTTP_HEADERS_RULES);
  expect(result.redacted).toContain('[REDACTED:x-auth-token]');
});

test('redacts an x-csrf-token header value', () => {
  const input = 'x-csrf-token: AbCdEfGhIjKlMnOpQrStUvWx';
  const result = applyRedaction(input, HTTP_HEADERS_RULES);
  expect(result.redacted).toContain('[REDACTED:x-csrf-token]');
});

test('redacts an Authorization AWS-SigV4 header', () => {
  const input =
    'Authorization: AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/20260101/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const result = applyRedaction(input, HTTP_HEADERS_RULES);
  expect(result.redacted).toContain('[REDACTED:aws-sigv4]');
});

test('redacts an Authorization HMAC-SHA256 header value', () => {
  const input = 'Authorization: HMAC-SHA256 AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIj';
  const result = applyRedaction(input, HTTP_HEADERS_RULES);
  expect(result.redacted).toContain('[REDACTED:authorization-hmac]');
});

test('redacts a Cookie header session value', () => {
  const input = 'Cookie: theme=dark; session=abc123def456ghi789jkl012';
  const result = applyRedaction(input, HTTP_HEADERS_RULES);
  expect(result.redacted).toContain('[REDACTED:cookie-auth-value]');
});

test('redacts a Set-Cookie header access_token value', () => {
  const input = 'Set-Cookie: access_token=AbCdEfGhIjKlMnOpQrStUvWx';
  const result = applyRedaction(input, HTTP_HEADERS_RULES);
  expect(result.redacted).toContain('[REDACTED:set-cookie-auth-value]');
});
