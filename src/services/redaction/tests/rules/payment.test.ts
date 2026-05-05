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

test('redacts a Square application ID (sq0idp-)', () => {
  const input = 'SQ_APP_ID=sq0idp-AbCdEfGhIjKlMnOpQrStUv';
  const result = applyRedaction(input, PAYMENT_RULES);
  expect(result.redacted).toContain('[REDACTED:square-app-id]');
});

test('redacts an Adyen API key', () => {
  const input =
    'ADYEN_KEY=AQE0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const result = applyRedaction(input, PAYMENT_RULES);
  expect(result.redacted).toContain('[REDACTED:adyen-api-key]');
});

test('redacts a BlockCypher token (keyword-anchored)', () => {
  const input = 'BLOCKCYPHER_TOKEN=0123456789abcdef0123456789abcdef';
  const result = applyRedaction(input, PAYMENT_RULES);
  expect(result.redacted).toContain('[REDACTED:blockcypher-token]');
});

test('redacts a PayPal client secret (keyword-anchored)', () => {
  const input =
    'PAYPAL_CLIENT_SECRET=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZab';
  const result = applyRedaction(input, PAYMENT_RULES);
  expect(result.redacted).toContain('[REDACTED:paypal-client-secret]');
});

test('redacts a Shopify shared webhook secret (keyword-anchored)', () => {
  const input = 'SHOPIFY_SHARED_SECRET=0123456789abcdef0123456789abcdef';
  const result = applyRedaction(input, PAYMENT_RULES);
  expect(result.redacted).toContain('[REDACTED:shopify-shared-secret]');
});

test('redacts a Razorpay key ID (rzp_live_)', () => {
  const input = 'RAZORPAY_KEY_ID=rzp_live_AbCdEfGhIjKlMn';
  const result = applyRedaction(input, PAYMENT_RULES);
  expect(result.redacted).toContain('[REDACTED:razorpay-key-id]');
});

test('redacts a Plaid client secret (keyword-anchored)', () => {
  const input = 'PLAID_SECRET=0123456789abcdef0123456789abcd';
  const result = applyRedaction(input, PAYMENT_RULES);
  expect(result.redacted).toContain('[REDACTED:plaid-secret]');
});
