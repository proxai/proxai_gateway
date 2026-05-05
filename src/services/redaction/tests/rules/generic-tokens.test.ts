import { expect, test } from 'bun:test';

import { applyRedaction } from 'services/redaction';
import { GENERIC_TOKENS_RULES } from 'services/redaction/rules/generic-tokens.ts';

test('redacts a standard JWT', () => {
  const input =
    'token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  const result = applyRedaction(input, GENERIC_TOKENS_RULES);
  expect(result.redacted).toContain('[REDACTED:jwt]');
});

test('does not match strings without eyJ on both header and payload', () => {
  const input = 'abc.def.ghi';
  const result = applyRedaction(input, GENERIC_TOKENS_RULES);
  expect(result.matchCount).toBe(0);
});

test('redacts a JSESSIONID cookie value', () => {
  const input = 'JSESSIONID=AbCdEfGhIjKlMnOpQrStUvWxYz12345';
  const result = applyRedaction(input, GENERIC_TOKENS_RULES);
  expect(result.redacted).toContain('[REDACTED:session-id-cookie]');
});

test('redacts a PHPSESSID cookie value', () => {
  const input = 'PHPSESSID=AbCdEfGhIjKlMnOpQrStUvWxYz12345';
  const result = applyRedaction(input, GENERIC_TOKENS_RULES);
  expect(result.redacted).toContain('[REDACTED:session-id-cookie]');
});

test('redacts a long hex private key value following hex_key keyword', () => {
  const input = 'priv_key_hex=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const result = applyRedaction(input, GENERIC_TOKENS_RULES);
  expect(result.redacted).toContain('[REDACTED:long-hex-private-key]');
});
