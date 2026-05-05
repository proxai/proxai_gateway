import { expect, test } from 'bun:test';

import { applyRedaction } from 'services/redaction';
import { CI_PACKAGE_MANAGERS_RULES } from 'services/redaction/rules/ci-package-managers.ts';

test('redacts an npm token', () => {
  const input = '//registry.npmjs.org/:_authToken=npm_AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKl';
  const result = applyRedaction(input, CI_PACKAGE_MANAGERS_RULES);
  expect(result.redacted).toContain('[REDACTED:npm-token]');
});

test('redacts a PyPI token', () => {
  const input =
    'PYPI_TOKEN=pypi-AgEIcHlwaS5vcmcCJDlhYjU2NWE3LTRkOWUtNDhmNS04NzY1LWQ4OTYzZjI1YjQ4Mw';
  const result = applyRedaction(input, CI_PACKAGE_MANAGERS_RULES);
  expect(result.redacted).toContain('[REDACTED:pypi-token]');
});

test('redacts a CircleCI personal token', () => {
  const input = 'CIRCLECI_TOKEN=CCIPAT_AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEf';
  const result = applyRedaction(input, CI_PACKAGE_MANAGERS_RULES);
  expect(result.redacted).toContain('[REDACTED:circleci-personal-token]');
});

test('redacts a Postman API key', () => {
  const input = 'POSTMAN_KEY=PMAK-1234567890abcdef12345678-1234567890abcdef1234567890abcdef12';
  const result = applyRedaction(input, CI_PACKAGE_MANAGERS_RULES);
  expect(result.redacted).toContain('[REDACTED:postman-api-key]');
});

test('redacts a Pulumi access token', () => {
  const input = 'PULUMI_TOKEN=pul-1234567890abcdef1234567890abcdef12345678';
  const result = applyRedaction(input, CI_PACKAGE_MANAGERS_RULES);
  expect(result.redacted).toContain('[REDACTED:pulumi-access-token]');
});
