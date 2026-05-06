import { expect, test } from 'bun:test';

import { auditRulesAgainstFixtures } from 'services/redaction/preserve.ts';
import type { RedactionRule } from 'services/redaction/redaction.types.ts';

test('returns findings when a rule pattern matches a fixture', () => {
  const rule: RedactionRule = {
    id: 'test-rule',
    description: 'matches the literal "secret"',
    pattern: /secret/g,
    replacement: '[REDACTED]',
  };
  const findings = auditRulesAgainstFixtures([rule], ['this has a secret in it']);
  expect(findings).toHaveLength(1);
  expect(findings[0]?.ruleId).toBe('test-rule');
  expect(findings[0]?.match).toBe('secret');
});

test('returns multiple findings when a rule matches multiple times', () => {
  const rule: RedactionRule = {
    id: 'multi',
    description: 'matches "x"',
    pattern: /x/g,
    replacement: '[X]',
  };
  const findings = auditRulesAgainstFixtures([rule], ['xxx']);
  expect(findings).toHaveLength(3);
});

test('returns empty when no rule matches any fixture', () => {
  const rule: RedactionRule = {
    id: 'no-match',
    description: '',
    pattern: /never-found/g,
    replacement: 'x',
  };
  expect(auditRulesAgainstFixtures([rule], ['hello world'])).toEqual([]);
});

test('returns empty when no rules and no fixtures', () => {
  expect(auditRulesAgainstFixtures([], [])).toEqual([]);
});
