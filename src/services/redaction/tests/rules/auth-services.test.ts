import { expect, test } from 'bun:test';

import { applyRedaction } from 'services/redaction';
import { AUTH_SERVICES_RULES } from 'services/redaction/rules/auth-services.ts';

test('redacts a Twilio Account SID (AC + 32 hex)', () => {
  const input = 'TWILIO_ACCOUNT_SID=AC1234567890abcdef1234567890abcdef';
  const result = applyRedaction(input, AUTH_SERVICES_RULES);
  expect(result.redacted).toContain('[REDACTED:twilio-account-sid]');
});

test('redacts a Twilio API key (SK + 32 hex)', () => {
  const input = 'TWILIO_API_KEY=SK1234567890abcdef1234567890abcdef';
  const result = applyRedaction(input, AUTH_SERVICES_RULES);
  expect(result.redacted).toContain('[REDACTED:twilio-api-key]');
});

test('redacts a SendGrid API key', () => {
  const input = 'SENDGRID_KEY=SG.AbCdEfGhIjKlMnOp.QrStUvWxYzAbCdEfGhIjKlMnOpQrStUvWxYzAb';
  const result = applyRedaction(input, AUTH_SERVICES_RULES);
  expect(result.redacted).toContain('[REDACTED:sendgrid-api-key]');
});

test('redacts a Mailgun API key (key-)', () => {
  const input = 'MAILGUN_KEY=key-1234567890abcdef1234567890abcdef';
  const result = applyRedaction(input, AUTH_SERVICES_RULES);
  expect(result.redacted).toContain('[REDACTED:mailgun-api-key]');
});

test('redacts a Mailchimp API key', () => {
  const input = 'MAILCHIMP_KEY=1234567890abcdef1234567890abcdef-us20';
  const result = applyRedaction(input, AUTH_SERVICES_RULES);
  expect(result.redacted).toContain('[REDACTED:mailchimp-api-key]');
});
