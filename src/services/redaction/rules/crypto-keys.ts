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
    id: 'pgp-private-key-block',
    description: 'PGP private key block',
    pattern: /-----BEGIN PGP PRIVATE KEY BLOCK-----[\s\S]+?-----END PGP PRIVATE KEY BLOCK-----/g,
    replacement: '[REDACTED:pgp-private-key-block]',
    stage: 1,
  },
  {
    id: 'private-key-block-fallback',
    description: 'Generic BEGIN/END block fallback (any prefix variant)',
    pattern: /-----BEGIN [^-]{0,40}-----[\s\S]+?-----END [^-]{0,40}-----/g,
    replacement: '[REDACTED:private-key-block]',
    stage: 2,
  },
  {
    id: 'age-secret-key',
    description: 'Age encryption secret key (AGE-SECRET-KEY-1...)',
    pattern: /\bAGE-SECRET-KEY-1[0-9A-Z]{50,}\b/g,
    replacement: '[REDACTED:age-secret-key]',
    stage: 1,
  },
  {
    id: 'putty-private-key',
    description: 'PuTTY user private key file (.ppk header)',
    pattern: /PuTTY-User-Key-File-\d+:[\s\S]+?Private-MAC:\s*[a-f0-9]+/g,
    replacement: '[REDACTED:putty-private-key]',
    stage: 1,
  },
  {
    id: 'minisign-secret-key',
    description: 'Minisign secret key file marker',
    pattern: /untrusted comment:\s*minisign encrypted secret key\s*\n[A-Za-z0-9+/=]{40,}/g,
    replacement: '[REDACTED:minisign-secret-key]',
    stage: 1,
  },
];
