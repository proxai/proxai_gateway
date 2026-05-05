import type { RedactionRule } from 'services/redaction/redaction.types.ts';

export const HTTP_HEADERS_RULES: readonly RedactionRule[] = [
  {
    id: 'authorization-bearer-header',
    description: 'Authorization: Bearer header value',
    pattern: /(authorization\s*[:=]\s*bearer\s+)[A-Za-z0-9._\-+/=]+/gi,
    replacement: '$1[REDACTED:bearer]',
    stage: 1,
  },
  {
    id: 'authorization-basic-header',
    description: 'Authorization: Basic header value',
    pattern: /(authorization\s*[:=]\s*basic\s+)[A-Za-z0-9+/=_-]+/gi,
    replacement: '$1[REDACTED:basic]',
    stage: 1,
  },
  {
    id: 'x-api-key-header',
    description: 'x-api-key / api-key / api_key HTTP header value',
    pattern: /(\b(?:x[-_])?api[-_]key\s*[:=]\s*)["']?[A-Za-z0-9._\-+/=]{16,}["']?/gi,
    replacement: '$1[REDACTED:api-key]',
    stage: 1,
  },
];
