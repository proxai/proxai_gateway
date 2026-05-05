import { expect, test } from 'bun:test';

import { applyRedaction } from 'services/redaction';
import { SOURCE_CONTROL_RULES } from 'services/redaction/rules/source-control.ts';

test('redacts a GitHub classic PAT (ghp_)', () => {
  const input = 'GITHUB_TOKEN=ghp_AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIj';
  const result = applyRedaction(input, SOURCE_CONTROL_RULES);
  expect(result.redacted).toContain('[REDACTED:github-pat]');
});

test('redacts a GitHub OAuth token (gho_)', () => {
  const input = 'token=gho_AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIj';
  const result = applyRedaction(input, SOURCE_CONTROL_RULES);
  expect(result.redacted).toContain('[REDACTED:github-pat]');
});

test('redacts a GitHub fine-grained PAT', () => {
  const input =
    'github_pat_11ABCDEFG_AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKl';
  const result = applyRedaction(input, SOURCE_CONTROL_RULES);
  expect(result.redacted).toContain('[REDACTED:github-fine-grained-pat]');
});

test('redacts a GitLab PAT', () => {
  const input = 'GITLAB_TOKEN=glpat-AbCdEfGhIjKlMnOpQrSt';
  const result = applyRedaction(input, SOURCE_CONTROL_RULES);
  expect(result.redacted).toContain('[REDACTED:gitlab-pat]');
});

test('redacts a GitLab pipeline trigger token', () => {
  const input = 'TRIGGER=glptt-AbCdEfGhIjKlMnOpQrStUvWx';
  const result = applyRedaction(input, SOURCE_CONTROL_RULES);
  expect(result.redacted).toContain('[REDACTED:gitlab-pipeline-trigger-token]');
});

test('redacts a GitLab deploy token', () => {
  const input = 'TOKEN=gldt-AbCdEfGhIjKlMnOpQrStUvWx';
  const result = applyRedaction(input, SOURCE_CONTROL_RULES);
  expect(result.redacted).toContain('[REDACTED:gitlab-deploy-token]');
});

test('redacts a GitLab feed token', () => {
  const input = 'FEED_TOKEN=glft-AbCdEfGhIjKlMnOpQrStUvWx';
  const result = applyRedaction(input, SOURCE_CONTROL_RULES);
  expect(result.redacted).toContain('[REDACTED:gitlab-feed-token]');
});

test('redacts a GitLab Runner registration token', () => {
  const input = 'RUNNER_TOKEN=GR13489411AbCdEfGhIjKlMnOpQrStUvWx';
  const result = applyRedaction(input, SOURCE_CONTROL_RULES);
  expect(result.redacted).toContain('[REDACTED:gitlab-runner-registration-token]');
});

test('redacts a GitLab incoming mail token', () => {
  const input = 'IMT=glimt-AbCdEfGhIjKlMnOpQrStUvWx';
  const result = applyRedaction(input, SOURCE_CONTROL_RULES);
  expect(result.redacted).toContain('[REDACTED:gitlab-incoming-mail-token]');
});

test('redacts a GitLab Runner authentication token', () => {
  const input = 'RT=glrt-AbCdEfGhIjKlMnOpQrStUvWx';
  const result = applyRedaction(input, SOURCE_CONTROL_RULES);
  expect(result.redacted).toContain('[REDACTED:gitlab-runner-auth-token]');
});

test('redacts a GitLab CI/CD job token', () => {
  const input = 'CI_JOB_TOKEN=glcbt-AbCdEfGhIjKlMnOpQrStUvWx';
  const result = applyRedaction(input, SOURCE_CONTROL_RULES);
  expect(result.redacted).toContain('[REDACTED:gitlab-cicd-job-token]');
});

test('redacts a Gitea access token (keyword-anchored)', () => {
  const input = 'gitea_token=0123456789abcdef0123456789abcdef01234567';
  const result = applyRedaction(input, SOURCE_CONTROL_RULES);
  expect(result.redacted).toContain('[REDACTED:gitea-access-token]');
});

test('redacts a Bitbucket app password (BBDC-)', () => {
  const input = 'BB_TOKEN=BBDC-AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEf';
  const result = applyRedaction(input, SOURCE_CONTROL_RULES);
  expect(result.redacted).toContain('[REDACTED:bitbucket-app-password]');
});

test('redacts an Azure DevOps PAT (keyword-anchored 52-char)', () => {
  const input = 'AZURE_DEVOPS_PAT=abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnop';
  const result = applyRedaction(input, SOURCE_CONTROL_RULES);
  expect(result.redacted).toContain('[REDACTED:azure-devops-pat]');
});
