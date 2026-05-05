import type { RedactionRule } from 'services/redaction/redaction.types.ts';

export const GENERIC_TOKENS_RULES: readonly RedactionRule[] = [
  {
    id: 'jwt',
    description: 'JSON Web Token (eyJ header + eyJ payload + signature)',
    pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    replacement: '[REDACTED:jwt]',
    stage: 1,
  },
];
