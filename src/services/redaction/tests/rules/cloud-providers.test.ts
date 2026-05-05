import { expect, test } from 'bun:test';

import { applyRedaction } from 'services/redaction';
import { CLOUD_PROVIDERS_RULES } from 'services/redaction/rules/cloud-providers.ts';

test('redacts an AWS access key (AKIA prefix)', () => {
  const input = 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE';
  const result = applyRedaction(input, CLOUD_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:aws-access-key]');
});

test('redacts an AWS session token id (ASIA prefix)', () => {
  const input = 'AWS_ACCESS_KEY_ID=ASIAIOSFODNN7EXAMPLE';
  const result = applyRedaction(input, CLOUD_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:aws-access-key]');
});

test('redacts a Google API key (AIza)', () => {
  const input = 'GOOGLE_API_KEY=AIzaSyB1234567890abcdefghijklmnopqrstuv';
  const result = applyRedaction(input, CLOUD_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:google-api-key]');
});

test('redacts a Google OAuth access token (ya29.)', () => {
  const input = 'access_token=ya29.AbCdEfGhIjKlMnOpQrStUvWxYz';
  const result = applyRedaction(input, CLOUD_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:google-oauth-access-token]');
});

test('redacts a Google OAuth client ID', () => {
  const input =
    'CLIENT_ID=123456789012-abcdefghijklmnopqrstuvwxyz123456.apps.googleusercontent.com';
  const result = applyRedaction(input, CLOUD_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:google-oauth-client-id]');
});

test('Stage 2 aws-secret-context redacts secret access key after canonical keyword', () => {
  const input = 'aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
  const result = applyRedaction(input, CLOUD_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:aws-secret-key]');
});
