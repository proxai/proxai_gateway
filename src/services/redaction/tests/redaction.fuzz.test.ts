import { describe, expect, test } from 'bun:test';

import { applyAllRedaction } from 'services/redaction';

interface PositiveFixture {
  label: string;
  input: string;
  mustContain: string;
}

const positiveFixtures: PositiveFixture[] = [
  {
    label: 'anthropic-api-key',
    input: 'export ANTHROPIC_API_KEY=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIj',
    mustContain: '[REDACTED:anthropic-api-key]',
  },
  {
    label: 'openai-api-key (legacy)',
    input: 'OPENAI_KEY=sk-AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQrSt',
    mustContain: '[REDACTED:openai-api-key]',
  },
  {
    label: 'openai-api-key (project)',
    input: 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQrSt',
    mustContain: '[REDACTED:openai-api-key]',
  },
  {
    label: 'huggingface-token',
    input: 'HF_TOKEN=hf_AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGh',
    mustContain: '[REDACTED:huggingface-token]',
  },
  {
    label: 'replicate-token',
    input: 'r8_AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlmn',
    mustContain: '[REDACTED:replicate-token]',
  },
  {
    label: 'github-pat-classic',
    input: 'ghp_AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIj',
    mustContain: '[REDACTED:github-pat]',
  },
  {
    label: 'github-fine-grained-pat',
    input: 'github_pat_11ABCDEFG_AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIj',
    mustContain: '[REDACTED:github-fine-grained-pat]',
  },
  {
    label: 'gitlab-pat',
    input: 'glpat-AbCdEfGhIjKlMnOpQrStUv',
    mustContain: '[REDACTED:gitlab-pat]',
  },
  {
    label: 'aws-access-key-AKIA',
    input: 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
    mustContain: '[REDACTED:aws-access-key]',
  },
  {
    label: 'aws-access-key-ASIA',
    input: 'AWS_ACCESS_KEY_ID=ASIAIOSFODNN7EXAMPLE',
    mustContain: '[REDACTED:aws-access-key]',
  },
  {
    label: 'aws-secret-context (Stage 2)',
    input: 'aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    mustContain: '[REDACTED:aws-secret-key]',
  },
  {
    label: 'google-api-key',
    input: 'GOOGLE_API_KEY=AIzaSyB1234567890abcdefghijklmnopqrstuv',
    mustContain: '[REDACTED:google-api-key]',
  },
  {
    label: 'google-oauth-access-token',
    input: 'access_token=ya29.AbCdEfGhIjKlMnOpQrStUvWxYz',
    mustContain: '[REDACTED:google-oauth-access-token]',
  },
  {
    label: 'google-oauth-client-id',
    input: 'CLIENT_ID=123456789012-abcdefghijklmnopqrstuvwxyz123456.apps.googleusercontent.com',
    mustContain: '[REDACTED:google-oauth-client-id]',
  },
  {
    label: 'slack-bot-token',
    input: 'SLACK_TOKEN=xoxb-1234567890-9876543210-AbCdEfGhIjKlMnOpQrStUvWxYz',
    mustContain: '[REDACTED:slack-token]',
  },
  {
    label: 'slack-incoming-webhook',
    input: 'https://hooks.slack.com/services/T01ABCDEFGH/B02ABCDEFGH/AbCdEfGhIjKlMnOpQrStUv',
    mustContain: '[REDACTED:slack-incoming-webhook]',
  },
  {
    label: 'discord-webhook',
    input: 'https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz',
    mustContain: '[REDACTED:discord-webhook]',
  },
  {
    label: 'discord-bot-token',
    input: 'TOKEN=AbCdEfGhIjKlMnOpQrStUvWx.YzAbCd.EfGhIjKlMnOpQrStUvWxYzAbCdEfG',
    mustContain: '[REDACTED:discord-bot-token]',
  },
  {
    label: 'telegram-bot-token',
    input: 'TELEGRAM_TOKEN=123456789:AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIj',
    mustContain: '[REDACTED:telegram-bot-token]',
  },
  {
    label: 'stripe-live-secret',
    input: 'STRIPE_KEY=sk_live_AbCdEfGhIjKlMnOpQrSt',
    mustContain: '[REDACTED:stripe-key]',
  },
  {
    label: 'stripe-test-secret',
    input: 'STRIPE_KEY=sk_test_AbCdEfGhIjKlMnOpQrSt',
    mustContain: '[REDACTED:stripe-key]',
  },
  {
    label: 'stripe-webhook-secret',
    input: 'STRIPE_WEBHOOK=whsec_AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEf',
    mustContain: '[REDACTED:stripe-webhook-secret]',
  },
  {
    label: 'twilio-account-sid',
    input: 'TWILIO_ACCOUNT_SID=AC1234567890abcdef1234567890abcdef',
    mustContain: '[REDACTED:twilio-account-sid]',
  },
  {
    label: 'twilio-api-key',
    input: 'TWILIO_API_KEY=SK1234567890abcdef1234567890abcdef',
    mustContain: '[REDACTED:twilio-api-key]',
  },
  {
    label: 'sendgrid-api-key',
    input: 'SENDGRID_KEY=SG.AbCdEfGhIjKlMnOp.QrStUvWxYzAbCdEfGhIjKlMnOpQrStUvWxYzAb',
    mustContain: '[REDACTED:sendgrid-api-key]',
  },
  {
    label: 'mailgun-api-key',
    input: 'MAILGUN_KEY=key-1234567890abcdef1234567890abcdef',
    mustContain: '[REDACTED:mailgun-api-key]',
  },
  {
    label: 'npm-token',
    input: '//registry.npmjs.org/:_authToken=npm_AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKl',
    mustContain: '[REDACTED:npm-token]',
  },
  {
    label: 'shopify-token',
    input: 'SHOPIFY_TOKEN=shpat_1234567890abcdef1234567890abcdef',
    mustContain: '[REDACTED:shopify-token]',
  },
  {
    label: 'notion-token',
    input: 'NOTION_KEY=secret_AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQrSt',
    mustContain: '[REDACTED:notion-token]',
  },
  {
    label: 'linear-api-key',
    input: 'LINEAR_KEY=lin_api_AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKl',
    mustContain: '[REDACTED:linear-api-key]',
  },
  {
    label: 'contentful-management-token',
    input: 'CONTENTFUL_TOKEN=CFPAT-AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOpQrSt',
    mustContain: '[REDACTED:contentful-management-token]',
  },
  {
    label: 'atlassian-api-token',
    input: 'JIRA_TOKEN=ATATT-AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKl',
    mustContain: '[REDACTED:atlassian-api-token]',
  },
  {
    label: 'databricks-token',
    input: 'DATABRICKS_TOKEN=dapi1234567890abcdef1234567890abcdef',
    mustContain: '[REDACTED:databricks-token]',
  },
  {
    label: 'doppler-token',
    input: 'DOPPLER_TOKEN=dp.pt.AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhIjKlMnOp',
    mustContain: '[REDACTED:doppler-token]',
  },
  {
    label: 'circleci-personal-token',
    input: 'CIRCLECI_TOKEN=CCIPAT_AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEf',
    mustContain: '[REDACTED:circleci-personal-token]',
  },
  {
    label: 'jwt',
    input:
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    mustContain: '[REDACTED:jwt]',
  },
  {
    label: 'pem-private-key',
    input: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----',
    mustContain: '[REDACTED:private-key]',
  },
  {
    label: 'authorization-bearer',
    input: 'Authorization: Bearer abc123def456ghi789jkl012',
    mustContain: '[REDACTED:bearer]',
  },
  {
    label: 'authorization-basic',
    input: 'Authorization: Basic dXNlcjpwYXNzd29yZA==',
    mustContain: '[REDACTED:basic]',
  },
  {
    label: 'x-api-key-header',
    input: 'x-api-key: sk_live_AbCdEfGhIjKlMnOpQrSt',
    mustContain: '[REDACTED:',
  },
  {
    label: 'db-connection-postgres',
    input: 'DATABASE_URL=postgresql://alice:supersecret123@db.example.com:5432/app',
    mustContain: '[REDACTED:db-connection-password]',
  },
  {
    label: 'db-connection-mysql',
    input: 'DB=mysql://root:adminPass!@localhost:3306/proddb',
    mustContain: '[REDACTED:db-connection-password]',
  },
  {
    label: 'db-connection-mongodb-srv',
    input: 'DB_URL=mongodb+srv://app:Pa$$w0rd@cluster0.mongodb.net/db',
    mustContain: '[REDACTED:db-connection-password]',
  },
  {
    label: 'keyword-secret-stage2',
    input: 'access_token = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"',
    mustContain: '[REDACTED:keyword-secret]',
  },
  {
    label: 'keyword-password-stage2',
    input: 'password=ThisIsLong1234567890Password',
    mustContain: '[REDACTED:keyword-secret]',
  },
];

const negativeFixtures: string[] = [
  '{"role": "user", "content": "hello world"}',
  '{"role": "assistant", "content": "I can help"}',
  '{"timestamp": "2026-04-29T10:42:00.123Z", "level": "info"}',
  '{"cwd": "/Users/alice/project", "model": "claude-sonnet-4-5"}',
  '{"turn_id": "abc-def-ghi-123", "type": "tool_use"}',
  '{"sessionId": "01943f5a-7b1c-7e92-9c01-a0f3b40d77e3"}',
  '{"composerId": "compose-abc-123", "bubbleId": "bubble-456"}',
  '{"name": "Read", "input": {"file_path": "/etc/hosts"}}',
  '{"name": "Bash", "input": {"command": "ls -la"}}',
  '{"name": "exec_command", "args": ["ls", "-la"]}',
  '{"name": "read_file_v2", "path": "/etc/hosts"}',
  '[INFO] application started successfully',
  'http://example.com/api/v1/users',
  'A short token: abc123 — too short to look like a secret',
  'sk-1234, sk-ant-1234, ghp_short, AKIA, eyJab',
  'random uuid: 01943f5a-7b1c-7e92-9c01-a0f3b40d77e3',
  '"inputTokens": 1234, "outputTokens": 5678',
  'log line: 2026-04-29T10:42:00Z INFO starting service',
  '{"type": "text", "text": "Lorem ipsum dolor sit amet."}',
];

describe('redaction fuzz harness — positive corpus (must redact)', () => {
  for (const fix of positiveFixtures) {
    test(fix.label, () => {
      const result = applyAllRedaction(fix.input);
      if (!result.redacted.includes(fix.mustContain)) {
        throw new Error(
          `expected "${fix.mustContain}" in redacted output for label "${fix.label}".\n  input:    ${fix.input}\n  redacted: ${result.redacted}`,
        );
      }
      expect(result.redacted).toContain(fix.mustContain);
    });
  }
});

describe('redaction fuzz harness — negative corpus (must NOT redact)', () => {
  for (const fix of negativeFixtures) {
    test(`leaves untouched: ${fix.slice(0, 70)}`, () => {
      const result = applyAllRedaction(fix);
      if (result.matchCount > 0) {
        throw new Error(
          `unexpected redaction for negative fixture.\n  input:    ${fix}\n  redacted: ${result.redacted}\n  hits: ${JSON.stringify(result.ruleHits)}`,
        );
      }
      expect(result.matchCount).toBe(0);
      expect(result.redacted).toBe(fix);
    });
  }
});
