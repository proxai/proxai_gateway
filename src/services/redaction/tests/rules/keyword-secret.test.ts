import { expect, test } from 'bun:test';

import { applyRedaction } from 'services/redaction';
import { KEYWORD_SECRET_RULES } from 'services/redaction/rules/keyword-secret.ts';

test('redacts secret following the secret keyword', () => {
  const input = 'my_secret = "abcdefghijklmnopqrstuvwxyz0123"';
  const result = applyRedaction(input, KEYWORD_SECRET_RULES);
  expect(result.redacted).toContain('[REDACTED:keyword-secret]');
});

test('redacts password value', () => {
  const input = 'password=ThisIsMyStrongPassword12345';
  const result = applyRedaction(input, KEYWORD_SECRET_RULES);
  expect(result.redacted).toContain('[REDACTED:keyword-secret]');
});

test('redacts api_key value', () => {
  const input = 'api_key: "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"';
  const result = applyRedaction(input, KEYWORD_SECRET_RULES);
  expect(result.redacted).toContain('[REDACTED:keyword-secret]');
});

test('redacts long base64 after credential keyword', () => {
  const input = 'signature=AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQrStUvWx';
  const result = applyRedaction(input, KEYWORD_SECRET_RULES);
  expect(result.redacted).toContain('[REDACTED:long-base64]');
});

test('does not match secretary as a keyword', () => {
  const input = 'secretary = aliceJohnson';
  const result = applyRedaction(input, KEYWORD_SECRET_RULES);
  expect(result.matchCount).toBe(0);
});

test('does not match values shorter than 16 chars', () => {
  const input = 'password=short123';
  const result = applyRedaction(input, KEYWORD_SECRET_RULES);
  expect(result.matchCount).toBe(0);
});
