import { expect, test } from 'bun:test';

import { applyRedaction } from 'services/redaction';
import { PAYMENT_RULES } from 'services/redaction/rules/payment.ts';

test('redacts a Stripe live secret key', () => {
  const input = 'STRIPE_KEY=sk_live_AbCdEfGhIjKlMnOpQrSt';
  const result = applyRedaction(input, PAYMENT_RULES);
  expect(result.redacted).toContain('[REDACTED:stripe-key]');
});

test('redacts a Stripe test secret key', () => {
  const input = 'STRIPE_KEY=sk_test_AbCdEfGhIjKlMnOpQrSt';
  const result = applyRedaction(input, PAYMENT_RULES);
  expect(result.redacted).toContain('[REDACTED:stripe-key]');
});

test('redacts a Stripe webhook secret', () => {
  const input = 'STRIPE_WEBHOOK=whsec_AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEf';
  const result = applyRedaction(input, PAYMENT_RULES);
  expect(result.redacted).toContain('[REDACTED:stripe-webhook-secret]');
});

test('redacts a Shopify access token (shpat_)', () => {
  const input = 'SHOPIFY_TOKEN=shpat_1234567890abcdef1234567890abcdef';
  const result = applyRedaction(input, PAYMENT_RULES);
  expect(result.redacted).toContain('[REDACTED:shopify-token]');
});
