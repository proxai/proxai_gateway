import { describe, expect, test } from 'bun:test';

import {
  ALL_RULES,
  auditRulesAgainstFixtures,
  PRESERVED_FIELD_CONTEXTS,
  PRESERVED_TOKENS,
} from 'services/redaction';

describe('preserve list — verbatim tokens are never matched', () => {
  test('no rule matches any verbatim preserved token', () => {
    const findings = auditRulesAgainstFixtures(ALL_RULES, PRESERVED_TOKENS);
    if (findings.length > 0) {
      throw new Error(
        `Preserved-token audit failed:\n${findings
          .map((f) => `  rule "${f.ruleId}" matched "${f.match}" inside "${f.fixture}"`)
          .join('\n')}`,
      );
    }
    expect(findings).toEqual([]);
  });
});

describe('preserve list — realistic JSON contexts are never matched', () => {
  test('no rule matches any preserved field-context fixture', () => {
    const findings = auditRulesAgainstFixtures(ALL_RULES, PRESERVED_FIELD_CONTEXTS);
    if (findings.length > 0) {
      throw new Error(
        `Preserved-context audit failed:\n${findings
          .map((f) => `  rule "${f.ruleId}" matched "${f.match}" inside "${f.fixture}"`)
          .join('\n')}`,
      );
    }
    expect(findings).toEqual([]);
  });
});
