import type { RedactionRule } from 'services/redaction/redaction.types.ts';

export const PAYMENT_RULES: readonly RedactionRule[] = [
  {
    id: 'stripe-key',
    description: 'Stripe live or test secret / publishable / restricted key',
    pattern: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g,
    replacement: '[REDACTED:stripe-key]',
  },
  {
    id: 'stripe-webhook-secret',
    description: 'Stripe webhook signing secret (whsec_)',
    pattern: /\bwhsec_[A-Za-z0-9]{32,}\b/g,
    replacement: '[REDACTED:stripe-webhook-secret]',
  },
  {
    id: 'paypal-braintree-access-token',
    description: 'PayPal / Braintree access token',
    pattern: /\baccess_token\$production\$[A-Za-z0-9]{16,}\$[A-Za-z0-9]{32,}\b/g,
    replacement: '[REDACTED:paypal-braintree-access-token]',
  },
  {
    id: 'shopify-token',
    description: 'Shopify access / private-app / shared-secret / custom token',
    pattern: /\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}\b/g,
    replacement: '[REDACTED:shopify-token]',
  },
  {
    id: 'square-access-token',
    description: 'Square access token (EAAA)',
    pattern: /\bEAAA[A-Za-z0-9_-]{60,}\b/g,
    replacement: '[REDACTED:square-access-token]',
  },
  {
    id: 'square-oauth-secret',
    description: 'Square OAuth secret (sq0csp-)',
    pattern: /\bsq0csp-[A-Za-z0-9_-]{43}\b/g,
    replacement: '[REDACTED:square-oauth-secret]',
  },
  {
    id: 'square-app-id',
    description: 'Square application ID (sq0idp-)',
    pattern: /\bsq0idp-[A-Za-z0-9_-]{22}\b/g,
    replacement: '[REDACTED:square-app-id]',
  },
  {
    id: 'adyen-api-key',
    description: 'Adyen API key (AQE prefix + 100+ char base64)',
    pattern: /\bAQE[A-Za-z0-9+/=]{100,}\b/g,
    replacement: '[REDACTED:adyen-api-key]',
  },
  {
    id: 'blockcypher-token',
    description: 'BlockCypher token (32 hex after BLOCKCYPHER keyword)',
    pattern: /(BLOCKCYPHER[_-]?(?:TOKEN|API[_-]?KEY)\s*[:=]\s*)["']?[a-f0-9]{32}["']?/gi,
    replacement: '$1[REDACTED:blockcypher-token]',
  },
  {
    id: 'paypal-client-secret-context',
    description: 'PayPal client secret value following PAYPAL keyword',
    pattern: /(PAYPAL[_-]?CLIENT[_-]?SECRET\s*[:=]\s*)["']?[A-Za-z0-9_-]{60,}["']?/gi,
    replacement: '$1[REDACTED:paypal-client-secret]',
  },
  {
    id: 'shopify-shared-secret-context',
    description: 'Shopify shared webhook secret following SHOPIFY keyword',
    pattern: /(SHOPIFY[_-]?(?:API[_-]?)?SHARED?[_-]?SECRET\s*[:=]\s*)["']?[a-f0-9]{32}["']?/gi,
    replacement: '$1[REDACTED:shopify-shared-secret]',
  },
  {
    id: 'razorpay-key-id',
    description: 'Razorpay key ID (rzp_live_ / rzp_test_)',
    pattern: /\brzp_(?:live|test)_[A-Za-z0-9]{14,}\b/g,
    replacement: '[REDACTED:razorpay-key-id]',
  },
  {
    id: 'plaid-secret-context',
    description: 'Plaid client secret value following PLAID keyword',
    pattern: /(PLAID[_-]?(?:CLIENT[_-]?)?SECRET\s*[:=]\s*)["']?[a-f0-9]{30,}["']?/gi,
    replacement: '$1[REDACTED:plaid-secret]',
  },
];
