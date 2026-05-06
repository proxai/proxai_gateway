import { AUTH_SERVICES_RULES } from 'services/redaction/rules/auth-services.ts';
import { CI_PACKAGE_MANAGERS_RULES } from 'services/redaction/rules/ci-package-managers.ts';
import { CLOUD_PROVIDERS_RULES } from 'services/redaction/rules/cloud-providers.ts';
import { COMMUNICATION_RULES } from 'services/redaction/rules/communication.ts';
import { CONNECTION_STRINGS_RULES } from 'services/redaction/rules/connection-strings.ts';
import { CRYPTO_KEYS_RULES } from 'services/redaction/rules/crypto-keys.ts';
import { GENERIC_TOKENS_RULES } from 'services/redaction/rules/generic-tokens.ts';
import { HTTP_HEADERS_RULES } from 'services/redaction/rules/http-headers.ts';
import { KEYWORD_SECRET_RULES } from 'services/redaction/rules/keyword-secret.ts';
import { LLM_PROVIDERS_RULES } from 'services/redaction/rules/llm-providers.ts';
import { PAYMENT_RULES } from 'services/redaction/rules/payment.ts';
import { SAAS_TOOLS_RULES } from 'services/redaction/rules/saas-tools.ts';
import { SOURCE_CONTROL_RULES } from 'services/redaction/rules/source-control.ts';
import type { RedactionRule, RuleCategory } from 'services/redaction/redaction.types.ts';

export { AUTH_SERVICES_RULES } from 'services/redaction/rules/auth-services.ts';
export { CI_PACKAGE_MANAGERS_RULES } from 'services/redaction/rules/ci-package-managers.ts';
export { CLOUD_PROVIDERS_RULES } from 'services/redaction/rules/cloud-providers.ts';
export { COMMUNICATION_RULES } from 'services/redaction/rules/communication.ts';
export { CONNECTION_STRINGS_RULES } from 'services/redaction/rules/connection-strings.ts';
export { CRYPTO_KEYS_RULES } from 'services/redaction/rules/crypto-keys.ts';
export { GENERIC_TOKENS_RULES } from 'services/redaction/rules/generic-tokens.ts';
export { HTTP_HEADERS_RULES } from 'services/redaction/rules/http-headers.ts';
export { KEYWORD_SECRET_RULES } from 'services/redaction/rules/keyword-secret.ts';
export { LLM_PROVIDERS_RULES } from 'services/redaction/rules/llm-providers.ts';
export { PAYMENT_RULES } from 'services/redaction/rules/payment.ts';
export { SAAS_TOOLS_RULES } from 'services/redaction/rules/saas-tools.ts';
export { SOURCE_CONTROL_RULES } from 'services/redaction/rules/source-control.ts';

// Order matters: most specific patterns run first so they replace before
// the generic keyword-anchored catch-alls fire. The keyword-secret category
// must stay LAST.
export const RULE_CATEGORIES: readonly RuleCategory[] = [
  {
    name: 'crypto-keys',
    description: 'Private keys (PEM, SSH, age, PGP, PuTTY, GCP service accounts)',
    rules: CRYPTO_KEYS_RULES,
  },
  {
    name: 'llm-providers',
    description: 'LLM provider API keys (OpenAI, Anthropic, Cohere, Mistral, Groq, etc.)',
    rules: LLM_PROVIDERS_RULES,
  },
  {
    name: 'source-control',
    description: 'Source-control credentials (GitHub, GitLab, Bitbucket, Gitea, Azure DevOps)',
    rules: SOURCE_CONTROL_RULES,
  },
  {
    name: 'cloud-providers',
    description: 'Cloud provider credentials (AWS, GCP, Azure, Cloudflare, Linode, etc.)',
    rules: CLOUD_PROVIDERS_RULES,
  },
  {
    name: 'generic-tokens',
    description:
      'Generic-shape secret patterns (session IDs, long hex private keys, UUIDs near auth keywords)',
    rules: GENERIC_TOKENS_RULES,
  },
  {
    name: 'communication',
    description: 'Messaging and webhook tokens (Slack, Discord, Teams, Mattermost, etc.)',
    rules: COMMUNICATION_RULES,
  },
  {
    name: 'payment',
    description: 'Payment processor credentials (Stripe, Shopify, PayPal, Razorpay, Plaid, etc.)',
    rules: PAYMENT_RULES,
  },
  {
    name: 'auth-services',
    description: 'Auth providers and identity services (Okta, Auth0, Twilio, SendGrid, etc.)',
    rules: AUTH_SERVICES_RULES,
  },
  {
    name: 'ci-package-managers',
    description: 'CI/CD systems and package managers (CircleCI, Travis, npm, PyPI, etc.)',
    rules: CI_PACKAGE_MANAGERS_RULES,
  },
  {
    name: 'saas-tools',
    description:
      'Observability and SaaS tool tokens (Datadog, New Relic, Segment, Algolia, PagerDuty, etc.)',
    rules: SAAS_TOOLS_RULES,
  },
  {
    name: 'http-headers',
    description:
      'HTTP header credentials (Authorization, X-API-Key, Cookie auth values, AWS SigV4)',
    rules: HTTP_HEADERS_RULES,
  },
  {
    name: 'connection-strings',
    description:
      'Database connection strings with embedded credentials (Postgres, MySQL, MongoDB, etc.)',
    rules: CONNECTION_STRINGS_RULES,
  },
  {
    name: 'keyword-secret',
    description:
      'Generic key=value secret patterns anchored on keywords (password, token, secret, etc.)',
    rules: KEYWORD_SECRET_RULES,
  },
];

export const ALL_RULES: readonly RedactionRule[] = RULE_CATEGORIES.flatMap((c) => c.rules);
