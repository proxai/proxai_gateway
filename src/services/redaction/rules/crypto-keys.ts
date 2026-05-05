import type { RedactionRule } from 'services/redaction/redaction.types.ts';

export const CRYPTO_KEYS_RULES: readonly RedactionRule[] = [
  {
    id: 'gcp-service-account-private-key',
    description: 'GCP service-account JSON private_key field (must run before pem-private-key)',
    pattern: /"private_key"\s*:\s*"-----BEGIN[\s\S]+?-----END[^"]*"/g,
    replacement: '"private_key": "[REDACTED:gcp-service-account-private-key]"',
    stage: 1,
  },
  {
    id: 'pem-private-key',
    description: 'PEM-formatted private key block (RSA, EC, OPENSSH, DSA, etc.)',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: '[REDACTED:private-key]',
    stage: 1,
  },
  {
    id: 'private-key-block-fallback',
    description: 'Generic BEGIN/END block fallback (any prefix variant)',
    pattern: /-----BEGIN [^-]{0,40}-----[\s\S]+?-----END [^-]{0,40}-----/g,
    replacement: '[REDACTED:private-key-block]',
    stage: 2,
  },
];
