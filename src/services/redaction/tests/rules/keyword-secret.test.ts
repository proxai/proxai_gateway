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

test('redacts a signing_key value', () => {
  const input = 'signing_key=AbCdEfGhIjKlMnOpQrStUvWxYz';
  const result = applyRedaction(input, KEYWORD_SECRET_RULES);
  expect(result.redacted).toContain('[REDACTED:extended-keyword-secret]');
});

test('redacts an integration_key value', () => {
  const input = 'integration_key=AbCdEfGhIjKlMnOpQrStUvWxYz';
  const result = applyRedaction(input, KEYWORD_SECRET_RULES);
  expect(result.redacted).toContain('[REDACTED:extended-keyword-secret]');
});

test('redacts a master_key value', () => {
  const input = 'master_key=AbCdEfGhIjKlMnOpQrStUvWxYz';
  const result = applyRedaction(input, KEYWORD_SECRET_RULES);
  expect(result.redacted).toContain('[REDACTED:extended-keyword-secret]');
});

test('redacts a service_key value', () => {
  const input = 'service_key=AbCdEfGhIjKlMnOpQrStUvWxYz';
  const result = applyRedaction(input, KEYWORD_SECRET_RULES);
  expect(result.redacted).toContain('[REDACTED:extended-keyword-secret]');
});

test('redacts an id_token value', () => {
  const input = 'id_token=AbCdEfGhIjKlMnOpQrStUvWxYz';
  const result = applyRedaction(input, KEYWORD_SECRET_RULES);
  expect(result.redacted).toContain('[REDACTED:bearer-token-keyword]');
});

test('redacts an environment variable with _PASSWORD suffix', () => {
  const input = 'DEPLOY_DB_PASSWORD=AbCdEfGhIjKlMnOpQrStUvWxYz';
  const result = applyRedaction(input, KEYWORD_SECRET_RULES);
  expect(result.redacted.toLowerCase()).toContain('[redacted:');
});
