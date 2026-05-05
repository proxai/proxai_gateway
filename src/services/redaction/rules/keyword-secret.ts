import type { RedactionRule } from 'services/redaction/redaction.types.ts';

export const KEYWORD_SECRET_RULES: readonly RedactionRule[] = [
  {
    id: 'keyword-anchored-secret',
    description: 'Generic value following a sensitive keyword in key=value form (Stage 2)',
    pattern:
      /((?:secret(?:[-_]?key)?|password|passwd|pwd|api[-_]?key|access[-_]?token|auth[-_]?token|client[-_]?secret|private[-_]?key|encryption[-_]?key|refresh[-_]?token)\s*[:=]\s*)["']?[A-Za-z0-9._\-+/=]{16,}["']?/gi,
    replacement: '$1[REDACTED:keyword-secret]',
    stage: 2,
  },
  {
    id: 'long-base64-after-keyword',
    description: 'Long base64-shaped value following a credential keyword (Stage 2)',
    pattern:
      /(\b(?:credential|signature|certificate|cert|hmac|salt)\s*[:=]\s*)["']?([A-Za-z0-9+/=]{32,})["']?/gi,
    replacement: '$1[REDACTED:long-base64]',
    stage: 2,
  },
];
