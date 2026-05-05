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

describe('Stage 1 — known formats', () => {
  test('redacts Anthropic API key', () => {
    const input = 'My key is sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYzAbCd-_';
    const result = applyStage1(input);
    expect(result.redacted).toContain('[REDACTED:anthropic-api-key]');
    expect(result.redacted).not.toContain('sk-ant-');
    expect(result.ruleHits['anthropic-api-key']).toBe(1);
  });

  test('redacts OpenAI API key', () => {
    const input = 'use sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKl';
    const result = applyStage1(input);
    expect(result.redacted).toContain('[REDACTED:openai-api-key]');
    expect(result.ruleHits['openai-api-key']).toBe(1);
  });

  test('OpenAI rule does not match Anthropic key', () => {
    const input = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOp';
    const result = applyStage1(input);
    expect(result.redacted).toContain('[REDACTED:anthropic-api-key]');
    expect(result.redacted).not.toContain('[REDACTED:openai-api-key]');
  });

  test('redacts GitHub PAT (ghp_)', () => {
    const input = 'export GITHUB_TOKEN=ghp_AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIj';
    const result = applyStage1(input);
    expect(result.redacted).toContain('[REDACTED:github-pat]');
  });

  test('redacts GitHub OAuth token (gho_)', () => {
    const input = 'token=gho_AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIj';
    const result = applyStage1(input);
    expect(result.redacted).toContain('[REDACTED:github-pat]');
  });

  test('redacts AWS Access Key', () => {
    const input = 'aws_access_key_id=AKIAIOSFODNN7EXAMPLE';
    const result = applyStage1(input);
    expect(result.redacted).toContain('[REDACTED:aws-access-key]');
  });

  test('redacts AWS session token id (ASIA)', () => {
    const input = 'aws_access_key_id=ASIAIOSFODNN7EXAMPLE';
    const result = applyStage1(input);
    expect(result.redacted).toContain('[REDACTED:aws-access-key]');
  });

  test('redacts Slack token', () => {
    const input = 'token=xoxb-1234567890-9876543210-AbCdEfGhIjKlMnOpQrSt';
    const result = applyStage1(input);
    expect(result.redacted).toContain('[REDACTED:slack-token]');
  });

  test('redacts Stripe live key', () => {
    const input = 'STRIPE_KEY=sk_live_AbCdEfGhIjKlMnOpQrSt';
    const result = applyStage1(input);
    expect(result.redacted).toContain('[REDACTED:stripe-key]');
  });

  test('redacts Stripe test key', () => {
    const input = 'STRIPE_KEY=sk_test_AbCdEfGhIjKlMnOpQrSt';
    const result = applyStage1(input);
    expect(result.redacted).toContain('[REDACTED:stripe-key]');
  });

  test('redacts Google API key', () => {
    const input = 'GOOGLE_API_KEY=AIzaSyB1234567890abcdefghijklmnopqrstuv';
    const result = applyStage1(input);
    expect(result.redacted).toContain('[REDACTED:google-api-key]');
  });

  test('redacts JWT', () => {
    const input =
      'token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const result = applyStage1(input);
    expect(result.redacted).toContain('[REDACTED:jwt]');
  });

  test('does not match short / non-key strings', () => {
    const input = 'short token sk-abc, AKIA123, eyJabc, ghp_abc';
    const result = applyStage1(input);
    expect(result.matchCount).toBe(0);
  });
});

describe('Stage 2 — header / pattern catch-all', () => {
  test('redacts Authorization Bearer header value', () => {
    const input = 'Authorization: Bearer abc123def456ghi789jkl012';
    const result = applyStage2(input);
    expect(result.redacted).toContain('[REDACTED:bearer]');
    expect(result.redacted.toLowerCase()).toContain('authorization: bearer');
  });

  test('redacts x-api-key header value', () => {
    const input = 'x-api-key: 1234567890abcdef0123456789';
    const result = applyStage2(input);
    expect(result.redacted).toContain('[REDACTED:api-key]');
    expect(result.redacted.toLowerCase()).toContain('x-api-key:');
  });

  test('redacts PEM private key block', () => {
    const input =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----';
    const result = applyStage2(input);
    expect(result.redacted).toContain('[REDACTED:private-key]');
    expect(result.redacted).not.toContain('MIIEow');
  });

  test('does not redact Authorization header without Bearer prefix', () => {
    const input = 'Authorization: Basic dXNlcjpwYXNz';
    const result = applyStage2(input);
    expect(result.redacted).toBe(input);
  });
});

describe('multi-match and combined-stage behavior', () => {
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

  test('applyAllRedaction combines Stage 1 and Stage 2', () => {
    const input =
      'API key sk-ant-AbCdEfGhIjKlMnOpQrStUv. Authorization: Bearer abc123def456ghi789jkl012';
    const result = applyAllRedaction(input);
    expect(result.redacted).toContain('[REDACTED:anthropic-api-key]');
    expect(result.redacted).toContain('[REDACTED:bearer]');
  });

  test('applyAllRedaction tags a JWT-shaped Bearer value as JWT, not bearer', () => {
    const input =
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV';
    const result = applyAllRedaction(input);
    expect(result.redacted).toContain('[REDACTED:jwt]');
  });

  test('returns original string when nothing matches', () => {
    const input = 'this is a totally innocent log line with no secrets';
    const result = applyStage1(input);
    expect(result.redacted).toBe(input);
    expect(result.matchCount).toBe(0);
    expect(Object.keys(result.ruleHits)).toHaveLength(0);
  });
});

describe('false-positive prevention', () => {
  test('does not redact JSON structural characters or field names', () => {
    const input = '{"api_key": "short", "auth": null, "version": 14}';
    const result = applyStage1(input);
    expect(result.redacted).toBe(input);
  });

  test('does not redact short values that look key-prefixed', () => {
    const input = 'sk-1234, sk-ant-1234, ghp_short, AKIA, eyJab';
    const result = applyStage1(input);
    expect(result.matchCount).toBe(0);
  });
});

describe('rule-corpus integrity', () => {
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

  test('every rule has a global flag (regex /g)', () => {
    for (const rule of ALL_RULES) {
      expect(rule.pattern.global).toBe(true);
    }
  });

  test('stage tag matches the bucket', () => {
    for (const rule of STAGE_1_RULES) expect(rule.stage).toBe(1);
    for (const rule of STAGE_2_RULES) expect(rule.stage).toBe(2);
  });
});

describe('applyRedaction with custom rules', () => {
  test('accepts a custom rule list', () => {
    const customRules = [
      {
        id: 'foo',
        description: 'foo word',
        pattern: /\bfoo\b/g,
        replacement: 'XXX',
        stage: 1 as const,
      },
    ];
    const result = applyRedaction('foo bar foo', customRules);
    expect(result.redacted).toBe('XXX bar XXX');
    expect(result.ruleHits['foo']).toBe(2);
  });

  test('preserves text outside matches', () => {
    const input = 'before sk-ant-AbCdEfGhIjKlMnOpQrStUv after';
    const result = applyStage1(input);
    expect(result.redacted).toContain('before ');
    expect(result.redacted).toContain(' after');
  });
});
