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
