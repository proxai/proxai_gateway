import { expect, test } from 'bun:test';

import { applyRedaction } from 'services/redaction';
import { CRYPTO_KEYS_RULES } from 'services/redaction/rules/crypto-keys.ts';

test('redacts a PEM RSA private key block', () => {
  const input =
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----';
  const result = applyRedaction(input, CRYPTO_KEYS_RULES);
  expect(result.redacted).toContain('[REDACTED:private-key]');
  expect(result.redacted).not.toContain('MIIEow');
});

test('redacts a PEM EC private key block', () => {
  const input = '-----BEGIN EC PRIVATE KEY-----\nMHQCAQEEIH...\n-----END EC PRIVATE KEY-----';
  const result = applyRedaction(input, CRYPTO_KEYS_RULES);
  expect(result.redacted).toContain('[REDACTED:private-key]');
});

test('redacts a GCP service-account JSON private_key field', () => {
  const input =
    '{"type": "service_account", "private_key": "-----BEGIN PRIVATE KEY-----\\nMIIEv...\\n-----END PRIVATE KEY-----"}';
  const result = applyRedaction(input, CRYPTO_KEYS_RULES);
  expect(result.redacted).toContain('[REDACTED:gcp-service-account-private-key]');
});

test('Stage 2 fallback redacts non-standard BEGIN/END blocks', () => {
  const input =
    '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjE=\n-----END OPENSSH PRIVATE KEY-----';
  const result = applyRedaction(input, CRYPTO_KEYS_RULES);
  expect(result.redacted).toContain('[REDACTED:');
});
