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

test('redacts an Age secret key', () => {
  const input = 'KEY=AGE-SECRET-KEY-1QYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGPQYQSZQGZ8Y';
  const result = applyRedaction(input, CRYPTO_KEYS_RULES);
  expect(result.redacted).toContain('[REDACTED:age-secret-key]');
});

test('redacts a PuTTY .ppk private key block', () => {
  const input =
    'PuTTY-User-Key-File-3: ssh-rsa\nEncryption: none\nComment: rsa-key\nPublic-Lines: 6\nAAAA...\nPrivate-Lines: 14\nAAA...\nPrivate-MAC: 1234abcd5678ef9012345678abcdef1234567890';
  const result = applyRedaction(input, CRYPTO_KEYS_RULES);
  expect(result.redacted).toContain('[REDACTED:putty-private-key]');
});

test('redacts a PGP private key block', () => {
  const input =
    '-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBGAaaaaa\n-----END PGP PRIVATE KEY BLOCK-----';
  const result = applyRedaction(input, CRYPTO_KEYS_RULES);
  expect(result.redacted).toContain('[REDACTED:pgp-private-key-block]');
});

test('redacts a minisign secret key marker block', () => {
  const input =
    'untrusted comment: minisign encrypted secret key\nRWRTY0IyXdaZHUGQyN3ZXFwoq8eaR9eR3jtkAk5KSE3oTjKaBcBzRKjUwx9V';
  const result = applyRedaction(input, CRYPTO_KEYS_RULES);
  expect(result.redacted).toContain('[REDACTED:minisign-secret-key]');
});
