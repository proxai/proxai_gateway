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

test('redacts a CircleCI context token (CCI_)', () => {
  const input = 'CONTEXT_TOKEN=CCI_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ABCDEF';
  const result = applyRedaction(input, CI_PACKAGE_MANAGERS_RULES);
  expect(result.redacted).toContain('[REDACTED:circleci-context-token]');
});

test('redacts a Travis CI token (keyword-anchored)', () => {
  const input = 'TRAVIS_TOKEN=AbCdEfGhIjKlMnOpQrStUv';
  const result = applyRedaction(input, CI_PACKAGE_MANAGERS_RULES);
  expect(result.redacted).toContain('[REDACTED:travis-ci-token]');
});

test('redacts a Buildkite agent token (keyword-anchored)', () => {
  const input = 'BUILDKITE_AGENT_TOKEN=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ABCD';
  const result = applyRedaction(input, CI_PACKAGE_MANAGERS_RULES);
  expect(result.redacted).toContain('[REDACTED:buildkite-agent-token]');
});

test('redacts a Drone CI token (keyword-anchored)', () => {
  const input = 'DRONE_TOKEN=AbCdEfGhIjKlMnOpQrStUvWxYz123456';
  const result = applyRedaction(input, CI_PACKAGE_MANAGERS_RULES);
  expect(result.redacted).toContain('[REDACTED:drone-ci-token]');
});

test('redacts a Cargo crates.io registry token', () => {
  const input = 'CARGO_REGISTRY_TOKEN=cio0123456789abcdef0123456789abcdef';
  const result = applyRedaction(input, CI_PACKAGE_MANAGERS_RULES);
  expect(result.redacted).toContain('[REDACTED:cargo-registry-token]');
});

test('redacts a RubyGems API key', () => {
  const input = 'RUBYGEMS_API_KEY=rubygems_0123456789abcdef0123456789abcdef0123456789abcdef';
  const result = applyRedaction(input, CI_PACKAGE_MANAGERS_RULES);
  expect(result.redacted).toContain('[REDACTED:rubygems-api-key]');
});

test('redacts a NuGet API key', () => {
  const input = 'NUGET_API_KEY=oy2abcdefghijklmnopqrstuvwxyz0123456789abcdefg';
  const result = applyRedaction(input, CI_PACKAGE_MANAGERS_RULES);
  expect(result.redacted).toContain('[REDACTED:nuget-api-key]');
});

test('redacts a Jenkins API token (keyword-anchored)', () => {
  const input = 'jenkins token: 110123456789abcdef0123456789abcdef';
  const result = applyRedaction(input, CI_PACKAGE_MANAGERS_RULES);
  expect(result.redacted).toContain('[REDACTED:jenkins-api-token]');
});

test('redacts a Codecov upload token (keyword-anchored UUID)', () => {
  const input = 'CODECOV_TOKEN=12345678-1234-1234-1234-123456789012';
  const result = applyRedaction(input, CI_PACKAGE_MANAGERS_RULES);
  expect(result.redacted).toContain('[REDACTED:codecov-upload-token]');
});

test('redacts a Snyk token (keyword-anchored UUID)', () => {
  const input = 'SNYK_TOKEN=12345678-1234-1234-1234-123456789012';
  const result = applyRedaction(input, CI_PACKAGE_MANAGERS_RULES);
  expect(result.redacted).toContain('[REDACTED:snyk-token]');
});
