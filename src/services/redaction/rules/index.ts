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
import type { RedactionRule } from 'services/redaction/redaction.types.ts';

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

export const ALL_RULES: readonly RedactionRule[] = [
  ...CRYPTO_KEYS_RULES,
  ...LLM_PROVIDERS_RULES,
  ...SOURCE_CONTROL_RULES,
  ...CLOUD_PROVIDERS_RULES,
  ...GENERIC_TOKENS_RULES,
  ...COMMUNICATION_RULES,
  ...PAYMENT_RULES,
  ...AUTH_SERVICES_RULES,
  ...CI_PACKAGE_MANAGERS_RULES,
  ...SAAS_TOOLS_RULES,
  ...HTTP_HEADERS_RULES,
  ...CONNECTION_STRINGS_RULES,
  ...KEYWORD_SECRET_RULES,
];

export const STAGE_1_RULES: readonly RedactionRule[] = ALL_RULES.filter((r) => r.stage === 1);

export const STAGE_2_RULES: readonly RedactionRule[] = ALL_RULES.filter((r) => r.stage === 2);
