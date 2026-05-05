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
  {
    id: 'extended-keyword-anchored-secret',
    description: 'Generic value following an extended sensitive keyword set (Stage 2)',
    pattern:
      /((?:consumer[-_]?secret|oauth[-_]?secret|app[-_]?secret|db[-_]?password|redis[-_]?password|mongo[-_]?password|jwt[-_]?secret|signing[-_]?key|webhook[-_]?secret|integration[-_]?key|integration[-_]?secret|service[-_]?key|master[-_]?key)\s*[:=]\s*)["']?[A-Za-z0-9._\-+/=]{16,}["']?/gi,
    replacement: '$1[REDACTED:extended-keyword-secret]',
    stage: 2,
  },
  {
    id: 'bearer-token-keyword-anchored',
    description: 'Bearer token value following a generic bearer keyword (Stage 2)',
    pattern:
      /(\b(?:bearer[-_]?token|id[-_]?token|access[-_]?bearer|oauth[-_]?token)\s*[:=]\s*)["']?[A-Za-z0-9._\-+/=]{16,}["']?/gi,
    replacement: '$1[REDACTED:bearer-token-keyword]',
    stage: 2,
  },
  {
    id: 'env-var-secret-suffix',
    description:
      'Environment-style variable ending in _SECRET / _KEY / _TOKEN with long value (Stage 2)',
    pattern:
      /\b([A-Z][A-Z0-9_]{2,}_(?:SECRET|TOKEN|KEY|PASSWORD|API_KEY))\s*[:=]\s*["']?[A-Za-z0-9._\-+/=]{20,}["']?/g,
    replacement: '$1=[REDACTED:env-var-secret]',
    stage: 2,
  },
];
