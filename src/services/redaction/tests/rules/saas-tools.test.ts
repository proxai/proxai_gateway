import { expect, test } from 'bun:test';

import { applyRedaction } from 'services/redaction';
import { SAAS_TOOLS_RULES } from 'services/redaction/rules/saas-tools.ts';

test('redacts a Notion integration secret', () => {
  const input = 'NOTION_TOKEN=secret_AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQrSt';
  const result = applyRedaction(input, SAAS_TOOLS_RULES);
  expect(result.redacted).toContain('[REDACTED:notion-token]');
});

test('redacts a Linear API key', () => {
  const input = 'LINEAR_KEY=lin_api_AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIj';
  const result = applyRedaction(input, SAAS_TOOLS_RULES);
  expect(result.redacted).toContain('[REDACTED:linear-api-key]');
});

test('redacts a Contentful management token', () => {
  const input = 'CONTENTFUL_TOKEN=CFPAT-AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQrSt';
  const result = applyRedaction(input, SAAS_TOOLS_RULES);
  expect(result.redacted).toContain('[REDACTED:contentful-management-token]');
});

test('redacts an Atlassian API token (ATATT)', () => {
  const input = 'JIRA_TOKEN=ATATT-AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKl';
  const result = applyRedaction(input, SAAS_TOOLS_RULES);
  expect(result.redacted).toContain('[REDACTED:atlassian-api-token]');
});

test('redacts a Databricks token', () => {
  const input = 'DATABRICKS_TOKEN=dapi1234567890abcdef1234567890abcdef';
  const result = applyRedaction(input, SAAS_TOOLS_RULES);
  expect(result.redacted).toContain('[REDACTED:databricks-token]');
});

test('redacts a Doppler service token', () => {
  const input = 'DOPPLER_TOKEN=dp.pt.AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOp';
  const result = applyRedaction(input, SAAS_TOOLS_RULES);
  expect(result.redacted).toContain('[REDACTED:doppler-token]');
});

test('redacts a Sentry organization token', () => {
  const input = 'SENTRY_TOKEN=sntrys_AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMn';
  const result = applyRedaction(input, SAAS_TOOLS_RULES);
  expect(result.redacted).toContain('[REDACTED:sentry-org-token]');
});

test('redacts a Figma API token', () => {
  const input = 'FIGMA_TOKEN=figd_AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOp';
  const result = applyRedaction(input, SAAS_TOOLS_RULES);
  expect(result.redacted).toContain('[REDACTED:figma-api-token]');
});

test('redacts a Dropbox access token', () => {
  const input =
    'DROPBOX_TOKEN=sl.AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQ';
  const result = applyRedaction(input, SAAS_TOOLS_RULES);
  expect(result.redacted).toContain('[REDACTED:dropbox-access-token]');
});

test('redacts a HashiCorp Vault token (hvs.)', () => {
  const input = 'VAULT_TOKEN=hvs.AbCdEfGhIjKlMnOpQrStUvWxYz';
  const result = applyRedaction(input, SAAS_TOOLS_RULES);
  expect(result.redacted).toContain('[REDACTED:hashicorp-vault-token]');
});

test('redacts a SonarCloud user token (squ_)', () => {
  const input = 'SONAR_TOKEN=squ_AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMn';
  const result = applyRedaction(input, SAAS_TOOLS_RULES);
  expect(result.redacted).toContain('[REDACTED:sonarcloud-token]');
});
