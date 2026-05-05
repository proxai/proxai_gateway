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

test('redacts an AWS MWS auth token', () => {
  const input = 'token=amzn.mws.4ea38b7b-f563-7709-4bae-87aebaae9876';
  const result = applyRedaction(input, CLOUD_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:aws-mws-auth-token]');
});

test('redacts an AWS session token after canonical keyword', () => {
  const input =
    'aws_session_token=FQoGZXIvYXdzEH4aDExampleTokenValueABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789AAAABBBBCCCCDDDDeeFFGG/HHIIJJKKLLMMNN';
  const result = applyRedaction(input, CLOUD_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:aws-session-token]');
});

test('redacts an Azure storage account key', () => {
  const input =
    'DefaultEndpointsProtocol=https;AccountKey=abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJabcdefghijklmn==';
  const result = applyRedaction(input, CLOUD_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:azure-storage-account-key]');
});

test('redacts an Azure shared access signature URL parameter', () => {
  const input =
    'https://example.blob.core.windows.net/container?sig=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIj';
  const result = applyRedaction(input, CLOUD_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:azure-shared-access-signature]');
});

test('redacts an Azure AD client secret after keyword', () => {
  const input = 'AZURE_CLIENT_SECRET=ABCdEf~GhIjKlMnOpQrStUvWxYz_0123-456789';
  const result = applyRedaction(input, CLOUD_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:azure-ad-client-secret]');
});

test('redacts a Cloudflare API token after keyword', () => {
  const input = 'CF_API_TOKEN=AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMn';
  const result = applyRedaction(input, CLOUD_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:cloudflare-api-token]');
});

test('redacts a Cloudflare global API key after keyword', () => {
  const input = 'CLOUDFLARE_API_KEY=0123456789abcdef0123456789abcdef0123456';
  const result = applyRedaction(input, CLOUD_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:cloudflare-global-api-key]');
});

test('redacts a Linode personal access token after keyword', () => {
  const input = 'LINODE_TOKEN=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const result = applyRedaction(input, CLOUD_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:linode-personal-access-token]');
});

test('redacts a Vultr API key after keyword', () => {
  const input = 'VULTR_API_KEY=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const result = applyRedaction(input, CLOUD_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:vultr-api-key]');
});

test('redacts an Oracle Cloud OCID API key', () => {
  const input =
    'user_ocid=ocid1.user.oc1..aaaaaaaa1bcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqr';
  const result = applyRedaction(input, CLOUD_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:oracle-cloud-api-key]');
});

test('redacts an IBM Cloud IAM API key after keyword', () => {
  const input = 'IBM_CLOUD_API_KEY=AbCdEfGhIjKlMnOpQrStUv-WxYzAbCdEfGhIjKlMnOpQr';
  const result = applyRedaction(input, CLOUD_PROVIDERS_RULES);
  expect(result.redacted).toContain('[REDACTED:ibm-cloud-iam-key]');
});
