import { describe, expect, test } from 'bun:test';

import {
  ALL_RULES,
  applyAllRedaction,
  applyRedaction,
  applyStage1,
  applyStage2,
  STAGE_1_RULES,
  STAGE_2_RULES,
} from 'services/redaction';

describe('engine — applyRedaction with a custom corpus', () => {
  test('replaces every match of a custom rule', () => {
    const rules = [
      {
        id: 'foo',
        description: 'foo word',
        pattern: /\bfoo\b/g,
        replacement: 'XXX',
        stage: 1 as const,
      },
    ];
    const result = applyRedaction('foo bar foo', rules);
    expect(result.redacted).toBe('XXX bar XXX');
    expect(result.ruleHits['foo']).toBe(2);
    expect(result.matchCount).toBe(2);
  });

  test('returns input unchanged when no rule matches', () => {
    const result = applyStage1('this is a totally innocent log line with no secrets');
    expect(result.redacted).toBe('this is a totally innocent log line with no secrets');
    expect(result.matchCount).toBe(0);
    expect(Object.keys(result.ruleHits)).toHaveLength(0);
  });

  test('preserves text outside matches', () => {
    const input = 'before sk-ant-AbCdEfGhIjKlMnOpQrStUv after';
    const result = applyStage1(input);
    expect(result.redacted).toContain('before ');
    expect(result.redacted).toContain(' after');
  });
});

describe('engine — multi-match and combined-stage behavior', () => {
  test('counts multiple matches of the same rule', () => {
    const input = 'AKIAIOSFODNN7EXAMPLE and AKIA1234567890123456';
    const result = applyStage1(input);
    expect(result.ruleHits['aws-access-key']).toBe(2);
    expect(result.matchCount).toBe(2);
  });

  test('aggregates ruleHits across rules', () => {
    const input = 'sk-ant-AbCdEfGhIjKlMnOpQrStUv plus AKIAIOSFODNN7EXAMPLE';
    const result = applyStage1(input);
    expect(result.ruleHits['anthropic-api-key']).toBe(1);
    expect(result.ruleHits['aws-access-key']).toBe(1);
    expect(result.matchCount).toBe(2);
  });

  test('applyAllRedaction combines Stage 1 and Stage 2 rules', () => {
    const input = 'API key sk-ant-AbCdEfGhIjKlMnOpQrStUv. password=anotherStrongValue1234';
    const result = applyAllRedaction(input);
    expect(result.redacted).toContain('[REDACTED:anthropic-api-key]');
    expect(result.redacted).toContain('[REDACTED:keyword-secret]');
  });

  test('applyAllRedaction tags a JWT-shaped Bearer value as JWT, not bearer', () => {
    const input =
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV';
    const result = applyAllRedaction(input);
    expect(result.redacted).toContain('[REDACTED:jwt]');
  });
});

describe('false-positive prevention', () => {
  test('does not redact JSON structural characters or schema field names', () => {
    const input = '{"role": "user", "type": "text", "turn_id": "abc-123"}';
    const result = applyStage1(input);
    expect(result.redacted).toBe(input);
  });

  test('does not redact short values that look key-prefixed', () => {
    const input = 'sk-1234, sk-ant-1234, ghp_short, AKIA, eyJab, hf_x';
    const result = applyStage1(input);
    expect(result.matchCount).toBe(0);
  });

  test('does not redact UUIDs alone', () => {
    const input = '01943f5a-7b1c-7e92-9c01-a0f3b40d77e3';
    const result = applyStage1(input);
    expect(result.matchCount).toBe(0);
  });
});

describe('rule corpus integrity', () => {
  test('every rule has a unique id', () => {
    const ids = ALL_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('STAGE_1_RULES and STAGE_2_RULES are disjoint', () => {
    const stage1Ids = new Set(STAGE_1_RULES.map((r) => r.id));
    const stage2Ids = new Set(STAGE_2_RULES.map((r) => r.id));
    for (const id of stage1Ids) {
      expect(stage2Ids.has(id)).toBe(false);
    }
  });

  test('every rule has the global flag set', () => {
    for (const rule of ALL_RULES) {
      expect(rule.pattern.global).toBe(true);
    }
  });

  test('every rule lists the right stage', () => {
    for (const rule of STAGE_1_RULES) expect(rule.stage).toBe(1);
    for (const rule of STAGE_2_RULES) expect(rule.stage).toBe(2);
  });

  test('replacement strings include [REDACTED:', () => {
    for (const rule of ALL_RULES) {
      expect(rule.replacement).toContain('[REDACTED:');
    }
  });

  test('STAGE_1_RULES and STAGE_2_RULES partition ALL_RULES', () => {
    expect(STAGE_1_RULES.length + STAGE_2_RULES.length).toBe(ALL_RULES.length);
  });

  test('every rule has a non-empty description', () => {
    for (const rule of ALL_RULES) {
      expect(rule.description.length).toBeGreaterThan(0);
    }
  });

  test('applyStage2 alone never matches input that Stage 1 already redacted to a [REDACTED:...] marker', () => {
    const stage1Output =
      'auth: [REDACTED:bearer], db: postgres://u:[REDACTED:db-connection-password]@h/d';
    const stage2 = applyStage2(stage1Output);
    expect(stage2.redacted).toBe(stage1Output);
  });
});
