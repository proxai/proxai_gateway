import { describe, expect, test } from 'bun:test';

import { ALL_RULES, applyRedaction } from 'services/redaction';

describe('engine — applyRedaction with a custom corpus', () => {
  test('replaces every match of a custom rule', () => {
    const rules = [
      {
        id: 'foo',
        description: 'foo word',
        pattern: /\bfoo\b/g,
        replacement: 'XXX',
      },
    ];
    const result = applyRedaction('foo bar foo', rules);
    expect(result.redacted).toBe('XXX bar XXX');
    expect(result.ruleHits['foo']).toBe(2);
    expect(result.matchCount).toBe(2);
  });

  test('returns input unchanged when no rule matches', () => {
    const result = applyRedaction('this is a totally innocent log line with no secrets');
    expect(result.redacted).toBe('this is a totally innocent log line with no secrets');
    expect(result.matchCount).toBe(0);
    expect(Object.keys(result.ruleHits)).toHaveLength(0);
  });

  test('preserves text outside matches', () => {
    const input = 'before sk-ant-AbCdEfGhIjKlMnOpQrStUv after';
    const result = applyRedaction(input);
    expect(result.redacted).toContain('before ');
    expect(result.redacted).toContain(' after');
  });
});

describe('engine — multi-match and combined-corpus behavior', () => {
  test('counts multiple matches of the same rule', () => {
    const input = 'AKIAIOSFODNN7EXAMPLE and AKIA1234567890123456';
    const result = applyRedaction(input);
    expect(result.ruleHits['aws-access-key']).toBe(2);
    expect(result.matchCount).toBe(2);
  });

  test('aggregates ruleHits across rules', () => {
    const input = 'sk-ant-AbCdEfGhIjKlMnOpQrStUv plus AKIAIOSFODNN7EXAMPLE';
    const result = applyRedaction(input);
    expect(result.ruleHits['anthropic-api-key']).toBe(1);
    expect(result.ruleHits['aws-access-key']).toBe(1);
    expect(result.matchCount).toBe(2);
  });

  test('applies inline AND keyword-anchored rules in a single pass', () => {
    const input = 'API key sk-ant-AbCdEfGhIjKlMnOpQrStUv. password=anotherStrongValue1234';
    const result = applyRedaction(input);
    expect(result.redacted).toContain('[REDACTED:anthropic-api-key]');
    expect(result.redacted).toContain('[REDACTED:keyword-secret]');
  });

  test('tags a JWT-shaped Bearer value as JWT, not bearer', () => {
    const input =
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV';
    const result = applyRedaction(input);
    expect(result.redacted).toContain('[REDACTED:jwt]');
  });
});

describe('false-positive prevention', () => {
  test('does not redact JSON structural characters or schema field names', () => {
    const input = '{"role": "user", "type": "text", "turn_id": "abc-123"}';
    const result = applyRedaction(input);
    expect(result.redacted).toBe(input);
  });

  test('does not redact short values that look key-prefixed', () => {
    const input = 'sk-1234, sk-ant-1234, ghp_short, AKIA, eyJab, hf_x';
    const result = applyRedaction(input);
    expect(result.matchCount).toBe(0);
  });

  test('does not redact UUIDs alone', () => {
    const input = '01943f5a-7b1c-7e92-9c01-a0f3b40d77e3';
    const result = applyRedaction(input);
    expect(result.matchCount).toBe(0);
  });
});

describe('rule corpus integrity', () => {
  test('every rule has a unique id', () => {
    const ids = ALL_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('every rule has the global flag set', () => {
    for (const rule of ALL_RULES) {
      expect(rule.pattern.global).toBe(true);
    }
  });

  test('replacement strings include [REDACTED:', () => {
    for (const rule of ALL_RULES) {
      expect(rule.replacement).toContain('[REDACTED:');
    }
  });

  test('every rule has a non-empty description', () => {
    for (const rule of ALL_RULES) {
      expect(rule.description.length).toBeGreaterThan(0);
    }
  });

  test('applying redaction twice on inline-pattern matches is idempotent', () => {
    const once = applyRedaction(
      'OPENAI_KEY=sk-AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQrSt and AKIAIOSFODNN7EXAMPLE',
    );
    const twice = applyRedaction(once.redacted);
    expect(twice.redacted).toBe(once.redacted);
    expect(twice.matchCount).toBe(0);
  });
});
