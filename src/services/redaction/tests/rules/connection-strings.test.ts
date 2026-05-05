import { expect, test } from 'bun:test';

import { applyRedaction } from 'services/redaction';
import { CONNECTION_STRINGS_RULES } from 'services/redaction/rules/connection-strings.ts';

test('redacts password embedded in a postgres URL', () => {
  const input = 'DATABASE_URL=postgresql://alice:supersecret123@db.example.com:5432/app';
  const result = applyRedaction(input, CONNECTION_STRINGS_RULES);
  expect(result.redacted).toContain('[REDACTED:db-connection-password]');
  expect(result.redacted).not.toContain('supersecret123');
  expect(result.redacted).toContain('alice:');
});

test('redacts password embedded in a mysql URL', () => {
  const input = 'DB=mysql://root:adminPass!@localhost:3306/proddb';
  const result = applyRedaction(input, CONNECTION_STRINGS_RULES);
  expect(result.redacted).toContain('[REDACTED:db-connection-password]');
});

test('redacts password embedded in a mongodb+srv URL', () => {
  const input = 'DB_URL=mongodb+srv://app:Pa$$w0rd@cluster0.mongodb.net/db';
  const result = applyRedaction(input, CONNECTION_STRINGS_RULES);
  expect(result.redacted).toContain('[REDACTED:db-connection-password]');
});

test('Stage 2 url-userinfo-credentials catches generic basic-auth URL', () => {
  const input = 'Connecting via https://alice:topsecret123@api.example.com/v1';
  const result = applyRedaction(input, CONNECTION_STRINGS_RULES);
  expect(result.redacted).toContain('[REDACTED:url-credentials]');
  expect(result.redacted).not.toContain('topsecret123');
});
