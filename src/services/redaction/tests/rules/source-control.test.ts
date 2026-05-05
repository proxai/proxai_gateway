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
