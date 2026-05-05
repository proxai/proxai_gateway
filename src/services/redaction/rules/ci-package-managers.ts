import type { RedactionRule } from 'services/redaction/redaction.types.ts';

export const CI_PACKAGE_MANAGERS_RULES: readonly RedactionRule[] = [
  {
    id: 'npm-token',
    description: 'npm access token (npm_)',
    pattern: /\bnpm_[A-Za-z0-9]{36,}\b/g,
    replacement: '[REDACTED:npm-token]',
    stage: 1,
  },
  {
    id: 'pypi-token',
    description: 'PyPI API token (pypi-)',
    pattern: /\bpypi-[A-Za-z0-9_-]{50,}\b/g,
    replacement: '[REDACTED:pypi-token]',
    stage: 1,
  },
  {
    id: 'circleci-personal-token',
    description: 'CircleCI personal access token (CCIPAT_)',
    pattern: /\bCCIPAT_[A-Za-z0-9_]{32,}\b/g,
    replacement: '[REDACTED:circleci-personal-token]',
    stage: 1,
  },
  {
    id: 'postman-api-key',
    description: 'Postman API key (PMAK-)',
    pattern: /\bPMAK-[a-fA-F0-9]{24}-[a-fA-F0-9]{34}\b/g,
    replacement: '[REDACTED:postman-api-key]',
    stage: 1,
  },
  {
    id: 'pulumi-access-token',
    description: 'Pulumi access token (pul-)',
    pattern: /\bpul-[a-f0-9]{40}\b/g,
    replacement: '[REDACTED:pulumi-access-token]',
    stage: 1,
  },
];
