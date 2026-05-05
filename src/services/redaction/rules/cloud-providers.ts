import type { RedactionRule } from 'services/redaction/redaction.types.ts';

export const CLOUD_PROVIDERS_RULES: readonly RedactionRule[] = [
  {
    id: 'aws-access-key',
    description: 'AWS Access Key ID (AKIA, ASIA, ABIA, ACCA, A3T*)',
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA|A3T[A-Z0-9])[A-Z0-9]{16}\b/g,
    replacement: '[REDACTED:aws-access-key]',
    stage: 1,
  },
  {
    id: 'google-api-key',
    description: 'Google API key (AIza)',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    replacement: '[REDACTED:google-api-key]',
    stage: 1,
  },
  {
    id: 'google-oauth-access-token',
    description: 'Google OAuth access token (ya29.)',
    pattern: /\bya29\.[0-9A-Za-z_-]{20,}\b/g,
    replacement: '[REDACTED:google-oauth-access-token]',
    stage: 1,
  },
  {
    id: 'google-oauth-client-id',
    description: 'Google OAuth client ID',
    pattern: /\b\d+-[a-z0-9_]{32}\.apps\.googleusercontent\.com\b/g,
    replacement: '[REDACTED:google-oauth-client-id]',
    stage: 1,
  },
  {
    id: 'firebase-cloud-messaging-key',
    description: 'Firebase Cloud Messaging server key',
    pattern: /\bAAAA[A-Za-z0-9_-]{7}:[A-Za-z0-9_-]{140,}\b/g,
    replacement: '[REDACTED:firebase-cloud-messaging-key]',
    stage: 1,
  },
  {
    id: 'digitalocean-token',
    description: 'DigitalOcean access / OAuth / refresh token (do[oprt]_v1_)',
    pattern: /\bdo[oprt]_v1_[a-f0-9]{60,}\b/g,
    replacement: '[REDACTED:digitalocean-token]',
    stage: 1,
  },
  {
    id: 'aws-secret-context',
    description: 'AWS secret access key value following the canonical keyword (Stage 2)',
    pattern: /(\baws_secret_access_key\s*[:=]\s*)["']?([A-Za-z0-9/+]{40})["']?/gi,
    replacement: '$1[REDACTED:aws-secret-key]',
    stage: 2,
  },
];
