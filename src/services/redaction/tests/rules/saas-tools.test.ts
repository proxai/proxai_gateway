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

test('redacts an Algolia admin API key (keyword-anchored)', () => {
  const input = 'ALGOLIA_ADMIN_API_KEY=0123456789abcdef0123456789abcdef';
  const result = applyRedaction(input, SAAS_TOOLS_RULES);
  expect(result.redacted).toContain('[REDACTED:algolia-admin-api-key]');
});

test('redacts an Asana personal access token', () => {
  const input = 'ASANA_TOKEN=1/1234567890123456:0123456789abcdef0123456789abcdef';
  const result = applyRedaction(input, SAAS_TOOLS_RULES);
  expect(result.redacted).toContain('[REDACTED:asana-personal-access-token]');
});

test('redacts a Datadog API key (keyword-anchored)', () => {
  const input = 'DATADOG_API_KEY=0123456789abcdef0123456789abcdef';
  const result = applyRedaction(input, SAAS_TOOLS_RULES);
  expect(result.redacted).toContain('[REDACTED:datadog-api-key]');
});

test('redacts a Datadog APP key (keyword-anchored)', () => {
  const input = 'DATADOG_APP_KEY=0123456789abcdef0123456789abcdef01234567';
  const result = applyRedaction(input, SAAS_TOOLS_RULES);
  expect(result.redacted).toContain('[REDACTED:datadog-app-key]');
});

test('redacts a Grafana service account token (glsa_)', () => {
  const input = 'GRAFANA_TOKEN=glsa_AbCdEfGhIjKlMnOpQrStUvWxYz012345_0123abcd';
  const result = applyRedaction(input, SAAS_TOOLS_RULES);
  expect(result.redacted).toContain('[REDACTED:grafana-service-account-token]');
});

test('redacts a Grafana Cloud access policy token (glc_)', () => {
  const input =
    'GRAFANA_CLOUD_TOKEN=glc_eyJrIjoiQWJDZEVmR2hJaktsTW5PcFFyU3RVdldYWVo9PSIsImEiOnRydWV9PT09';
  const result = applyRedaction(input, SAAS_TOOLS_RULES);
  expect(result.redacted).toContain('[REDACTED:grafana-cloud-access-policy-token]');
});

test('redacts an Intercom access token', () => {
  const input = 'INTERCOM_TOKEN=dG9rOg0123456789abcdefghijklmnopqrstuvwxyz0123456789';
  const result = applyRedaction(input, SAAS_TOOLS_RULES);
  expect(result.redacted).toContain('[REDACTED:intercom-access-token]');
});

test('redacts a Mapbox secret token (sk.eyJ)', () => {
  const input = 'MAPBOX_SECRET=sk.eyJ1Ijoic29tZXVzZXIiLCJhIjoiYWJjZGVmZ2hpams.0123456789abcdef';
  const result = applyRedaction(input, SAAS_TOOLS_RULES);
  expect(result.redacted).toContain('[REDACTED:mapbox-secret-token]');
});

test('redacts a New Relic license key', () => {
  const input = 'NEW_RELIC_LICENSE_KEY=0123456789abcdef0123456789abcdef0123NRAL';
  const result = applyRedaction(input, SAAS_TOOLS_RULES);
  expect(result.redacted).toContain('[REDACTED:newrelic-license-key]');
});

test('redacts a New Relic insights insert key (NRII-)', () => {
  const input = 'NEW_RELIC_INSERT_KEY=NRII-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
  const result = applyRedaction(input, SAAS_TOOLS_RULES);
  expect(result.redacted).toContain('[REDACTED:newrelic-insert-key]');
});

test('redacts a New Relic REST API key (NRAK-)', () => {
  const input = 'NEW_RELIC_API_KEY=NRAK-ABCDEFGHIJKLMNOPQRSTUVWXY01';
  const result = applyRedaction(input, SAAS_TOOLS_RULES);
  expect(result.redacted).toContain('[REDACTED:newrelic-rest-api-key]');
});

test('redacts a Salesforce OAuth access token', () => {
  const input =
    'SF_TOKEN=00D5g000004RZSV!AQ4AQDXxYzAbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQr.0123456789';
  const result = applyRedaction(input, SAAS_TOOLS_RULES);
  expect(result.redacted).toContain('[REDACTED:salesforce-access-token]');
});

test('redacts a Pendo integration key (keyword-anchored UUID)', () => {
  const input = 'PENDO_INTEGRATION_KEY=12345678-1234-1234-1234-123456789012';
  const result = applyRedaction(input, SAAS_TOOLS_RULES);
  expect(result.redacted).toContain('[REDACTED:pendo-integration-key]');
});

test('redacts a Crowdin access token (crwdn_)', () => {
  const input = 'CROWDIN_TOKEN=crwdn_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ABCDEFGH';
  const result = applyRedaction(input, SAAS_TOOLS_RULES);
  expect(result.redacted).toContain('[REDACTED:crowdin-access-token]');
});

test('redacts a Segment write key (keyword-anchored)', () => {
  const input = 'SEGMENT_WRITE_KEY=AbCdEfGhIjKlMnOpQrStUvWxYz123456';
  const result = applyRedaction(input, SAAS_TOOLS_RULES);
  expect(result.redacted).toContain('[REDACTED:segment-write-key]');
});

test('redacts a PagerDuty API key (keyword-anchored)', () => {
  const input = 'PAGERDUTY_API_TOKEN=AbCdEfGhIjKlMnOpQrSt';
  const result = applyRedaction(input, SAAS_TOOLS_RULES);
  expect(result.redacted).toContain('[REDACTED:pagerduty-api-key]');
});

test('redacts a LaunchDarkly access token (api- + UUID)', () => {
  const input = 'LD_TOKEN=api-12345678-1234-1234-1234-123456789012';
  const result = applyRedaction(input, SAAS_TOOLS_RULES);
  expect(result.redacted).toContain('[REDACTED:launchdarkly-access-token]');
});

test('redacts a Box developer token (keyword-anchored)', () => {
  const input = 'BOX_DEVELOPER_TOKEN=AbCdEfGhIjKlMnOpQrStUvWxYz123456';
  const result = applyRedaction(input, SAAS_TOOLS_RULES);
  expect(result.redacted).toContain('[REDACTED:box-developer-token]');
});

test('redacts a Zendesk API token (keyword-anchored)', () => {
  const input = 'ZENDESK_API_TOKEN=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ABCD';
  const result = applyRedaction(input, SAAS_TOOLS_RULES);
  expect(result.redacted).toContain('[REDACTED:zendesk-api-token]');
});
