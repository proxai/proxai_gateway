import type { RedactionRule } from 'services/redaction/redaction.types.ts';

export const GENERIC_TOKENS_RULES: readonly RedactionRule[] = [
  {
    id: 'jwt',
    description: 'JSON Web Token (eyJ header + eyJ payload + signature)',
    pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    replacement: '[REDACTED:jwt]',
  },
  {
    id: 'session-id-cookie',
    description: 'Session ID cookie value (Stage 2 keyword-anchored)',
    pattern:
      /(\b(?:JSESSIONID|PHPSESSID|connect\.sid|express\.sid|laravel_session)\s*[:=]\s*)["']?[A-Za-z0-9._%+/=-]{16,}["']?/g,
    replacement: '$1[REDACTED:session-id-cookie]',
  },
  {
    id: 'long-hex-private-key-context',
    description: 'Long hex blob (64+) following a key/secret keyword (Stage 2)',
    pattern:
      /(\b(?:hex[_-]?(?:key|secret|seed)|priv(?:ate)?[_-]?key[_-]?hex)\s*[:=]\s*)["']?[a-fA-F0-9]{64,}["']?/g,
    replacement: '$1[REDACTED:long-hex-private-key]',
  },
];
