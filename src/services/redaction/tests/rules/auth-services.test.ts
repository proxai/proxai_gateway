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

test('redacts an Okta API token (SSWS scheme)', () => {
  const input = 'Authorization: SSWS 0123456789abcdefghijklmnopqrstuvwxyzABCDEFG';
  const result = applyRedaction(input, AUTH_SERVICES_RULES);
  expect(result.redacted).toContain('[REDACTED:okta-api-token]');
});

test('redacts an Auth0 API token (keyword-anchored)', () => {
  const input =
    'AUTH0_API_TOKEN=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ABCDEFGHIJKLMNOPQRSTUVabcdefghij';
  const result = applyRedaction(input, AUTH_SERVICES_RULES);
  expect(result.redacted).toContain('[REDACTED:auth0-api-token]');
});

test('redacts an Authy API key (keyword-anchored)', () => {
  const input = 'AUTHY_API_KEY=AbCdEfGhIjKlMnOpQrStUvWxYz123456';
  const result = applyRedaction(input, AUTH_SERVICES_RULES);
  expect(result.redacted).toContain('[REDACTED:authy-api-key]');
});

test('redacts a Mailjet API key (keyword-anchored)', () => {
  const input = 'MJ_APIKEY_PUBLIC=0123456789abcdef0123456789abcdef';
  const result = applyRedaction(input, AUTH_SERVICES_RULES);
  expect(result.redacted).toContain('[REDACTED:mailjet-api-key]');
});

test('redacts a Sendinblue/Brevo API key (xkeysib-)', () => {
  const input =
    'BREVO_KEY=xkeysib-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef-AbCdEfGhIjKlMnOp';
  const result = applyRedaction(input, AUTH_SERVICES_RULES);
  expect(result.redacted).toContain('[REDACTED:sendinblue-brevo-api-key]');
});

test('redacts a Sendinblue SMTP key (xsmtpsib-)', () => {
  const input =
    'SIB_SMTP=xsmtpsib-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef-AbCdEfGhIjKlMnOp';
  const result = applyRedaction(input, AUTH_SERVICES_RULES);
  expect(result.redacted).toContain('[REDACTED:sendinblue-smtp-key]');
});

test('redacts a Frontegg client secret (keyword-anchored UUID)', () => {
  const input = 'FRONTEGG_CLIENT_SECRET=12345678-1234-1234-1234-123456789012';
  const result = applyRedaction(input, AUTH_SERVICES_RULES);
  expect(result.redacted).toContain('[REDACTED:frontegg-api-token]');
});

test('redacts a MailerSend API token (mlsn.)', () => {
  const input =
    'MAILERSEND_TOKEN=mlsn.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const result = applyRedaction(input, AUTH_SERVICES_RULES);
  expect(result.redacted).toContain('[REDACTED:mailersend-api-token]');
});
