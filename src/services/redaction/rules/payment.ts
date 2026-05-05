import type { RedactionRule } from 'services/redaction/redaction.types.ts';

export const PAYMENT_RULES: readonly RedactionRule[] = [
  {
    id: 'stripe-key',
    description: 'Stripe live or test secret / publishable / restricted key',
    pattern: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g,
    replacement: '[REDACTED:stripe-key]',
    stage: 1,
  },
  {
    id: 'stripe-webhook-secret',
    description: 'Stripe webhook signing secret (whsec_)',
    pattern: /\bwhsec_[A-Za-z0-9]{32,}\b/g,
    replacement: '[REDACTED:stripe-webhook-secret]',
    stage: 1,
  },
  {
    id: 'paypal-braintree-access-token',
    description: 'PayPal / Braintree access token',
    pattern: /\baccess_token\$production\$[A-Za-z0-9]{16,}\$[A-Za-z0-9]{32,}\b/g,
    replacement: '[REDACTED:paypal-braintree-access-token]',
    stage: 1,
  },
  {
    id: 'shopify-token',
    description: 'Shopify access / private-app / shared-secret / custom token',
    pattern: /\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}\b/g,
    replacement: '[REDACTED:shopify-token]',
    stage: 1,
  },
  {
    id: 'square-access-token',
    description: 'Square access token (EAAA)',
    pattern: /\bEAAA[A-Za-z0-9_-]{60,}\b/g,
    replacement: '[REDACTED:square-access-token]',
    stage: 1,
  },
  {
    id: 'square-oauth-secret',
    description: 'Square OAuth secret (sq0csp-)',
    pattern: /\bsq0csp-[A-Za-z0-9_-]{43}\b/g,
    replacement: '[REDACTED:square-oauth-secret]',
    stage: 1,
  },
];
