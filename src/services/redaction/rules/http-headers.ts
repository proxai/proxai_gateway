import type { RedactionRule } from 'services/redaction/redaction.types.ts';

export const HTTP_HEADERS_RULES: readonly RedactionRule[] = [
  {
    id: 'authorization-bearer-header',
    description: 'Authorization: Bearer header value',
    pattern: /(authorization\s*[:=]\s*bearer\s+)[A-Za-z0-9._\-+/=]+/gi,
    replacement: '$1[REDACTED:bearer]',
  },
  {
    id: 'authorization-basic-header',
    description: 'Authorization: Basic header value',
    pattern: /(authorization\s*[:=]\s*basic\s+)[A-Za-z0-9+/=_-]+/gi,
    replacement: '$1[REDACTED:basic]',
  },
  {
    id: 'x-api-key-header',
    description: 'x-api-key / api-key / api_key HTTP header value',
    pattern: /(\b(?:x[-_])?api[-_]key\s*[:=]\s*)["']?[A-Za-z0-9._\-+/=]{16,}["']?/gi,
    replacement: '$1[REDACTED:api-key]',
  },
  {
    id: 'x-auth-token-header',
    description: 'x-auth-token / auth-token HTTP header value',
    pattern: /(\b(?:x[-_])?auth[-_]token\s*[:=]\s*)["']?[A-Za-z0-9._\-+/=]{16,}["']?/gi,
    replacement: '$1[REDACTED:x-auth-token]',
  },
  {
    id: 'x-csrf-token-header',
    description: 'x-csrf-token HTTP header value',
    pattern: /(\b(?:x[-_])?csrf[-_]token\s*[:=]\s*)["']?[A-Za-z0-9._\-+/=]{16,}["']?/gi,
    replacement: '$1[REDACTED:x-csrf-token]',
  },
  {
    id: 'authorization-aws-sigv4',
    description: 'Authorization header using AWS Signature v4 scheme',
    pattern:
      /(authorization\s*[:=]\s*AWS4-HMAC-SHA256\s+)Credential=[^,\s]+,\s*SignedHeaders=[^,\s]+,\s*Signature=[a-f0-9]{64}/gi,
    replacement: '$1[REDACTED:aws-sigv4]',
  },
  {
    id: 'authorization-hmac-sha-header',
    description: 'Authorization header using a HMAC-SHA scheme (signature byte string)',
    pattern: /(authorization\s*[:=]\s*hmac(?:-sha\d{0,3})?\s+)[A-Za-z0-9+/=._-]{20,}/gi,
    replacement: '$1[REDACTED:authorization-hmac]',
  },
  {
    id: 'cookie-header-auth-value',
    description: 'Cookie header sensitive auth keys (auth_token, access_token, sid, session)',
    pattern:
      /((?:^|\n)cookie\s*:\s*[^\n]*?(?:auth_token|access_token|session_token|session_id|sid|session)\s*=\s*)["']?[A-Za-z0-9._%+/=-]{16,}["']?/gi,
    replacement: '$1[REDACTED:cookie-auth-value]',
  },
  {
    id: 'set-cookie-auth-value',
    description: 'Set-Cookie header sensitive auth keys',
    pattern:
      /(\bset-cookie\s*:\s*(?:auth_token|access_token|session_token|session_id|sid|session)\s*=\s*)["']?[A-Za-z0-9._%+/=-]{16,}["']?/gi,
    replacement: '$1[REDACTED:set-cookie-auth-value]',
  },
];
