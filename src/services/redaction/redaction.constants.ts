import type { RedactionRule } from 'services/redaction/redaction.types.ts';

export const STAGE_1_RULES: readonly RedactionRule[] = [
  {
    id: 'anthropic-api-key',
    description: 'Anthropic API key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    replacement: '[REDACTED:anthropic-api-key]',
    stage: 1,
  },
  {
    id: 'openai-api-key',
    description: 'OpenAI API key',
    pattern: /\bsk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/g,
    replacement: '[REDACTED:openai-api-key]',
    stage: 1,
  },
  {
    id: 'github-pat',
    description: 'GitHub Personal Access Token',
    pattern: /\bgh[pours]_[A-Za-z0-9]{30,}\b/g,
    replacement: '[REDACTED:github-pat]',
    stage: 1,
  },
  {
    id: 'aws-access-key',
    description: 'AWS Access Key ID',
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    replacement: '[REDACTED:aws-access-key]',
    stage: 1,
  },
  {
    id: 'slack-token',
    description: 'Slack token',
    pattern: /\bxox[abprs]-\d{10,}-\d{10,}-[A-Za-z0-9]{20,}\b/g,
    replacement: '[REDACTED:slack-token]',
    stage: 1,
  },
  {
    id: 'stripe-key',
    description: 'Stripe live or test key',
    pattern: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g,
    replacement: '[REDACTED:stripe-key]',
    stage: 1,
  },
  {
    id: 'google-api-key',
    description: 'Google API key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    replacement: '[REDACTED:google-api-key]',
    stage: 1,
  },
  {
    id: 'jwt',
    description: 'JSON Web Token',
    pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    replacement: '[REDACTED:jwt]',
    stage: 1,
  },
];

export const STAGE_2_RULES: readonly RedactionRule[] = [
  {
    id: 'authorization-bearer',
    description: 'Authorization: Bearer header value',
    pattern: /(authorization\s*[:=]\s*bearer\s+)[A-Za-z0-9._\-+/=]+/gi,
    replacement: '$1[REDACTED:bearer]',
    stage: 2,
  },
  {
    id: 'x-api-key-header',
    description: 'x-api-key header value',
    pattern: /(x[-_]api[-_]key\s*[:=]\s*)["']?[A-Za-z0-9._\-+/=]{16,}["']?/gi,
    replacement: '$1[REDACTED:api-key]',
    stage: 2,
  },
  {
    id: 'private-key-pem',
    description: 'PEM-formatted private key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: '[REDACTED:private-key]',
    stage: 2,
  },
];

export const ALL_RULES: readonly RedactionRule[] = [...STAGE_1_RULES, ...STAGE_2_RULES];
