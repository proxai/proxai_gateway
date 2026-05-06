import type { RedactionRule } from 'services/redaction/redaction.types.ts';

export const SOURCE_CONTROL_RULES: readonly RedactionRule[] = [
  {
    id: 'github-fine-grained-pat',
    description: 'GitHub fine-grained personal access token (github_pat_)',
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    replacement: '[REDACTED:github-fine-grained-pat]',
  },
  {
    id: 'github-pat',
    description: 'GitHub personal / OAuth / app token (gh[pours]_)',
    pattern: /\bgh[pours]_[A-Za-z0-9]{30,}\b/g,
    replacement: '[REDACTED:github-pat]',
  },
  {
    id: 'gitlab-pat',
    description: 'GitLab personal access token (glpat-)',
    pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
    replacement: '[REDACTED:gitlab-pat]',
  },
  {
    id: 'gitlab-pipeline-trigger-token',
    description: 'GitLab pipeline trigger token (glptt-)',
    pattern: /\bglptt-[A-Za-z0-9_-]{20,}\b/g,
    replacement: '[REDACTED:gitlab-pipeline-trigger-token]',
  },
  {
    id: 'gitlab-deploy-token',
    description: 'GitLab deploy token (gldt-)',
    pattern: /\bgldt-[A-Za-z0-9_-]{20,}\b/g,
    replacement: '[REDACTED:gitlab-deploy-token]',
  },
  {
    id: 'gitlab-feed-token',
    description: 'GitLab feed token (glft-)',
    pattern: /\bglft-[A-Za-z0-9_-]{20,}\b/g,
    replacement: '[REDACTED:gitlab-feed-token]',
  },
  {
    id: 'gitlab-runner-registration-token',
    description: 'GitLab Runner registration token (GR + 8 digits + 20 chars)',
    pattern: /\bGR\d{8}[A-Za-z0-9_-]{20,}\b/g,
    replacement: '[REDACTED:gitlab-runner-registration-token]',
  },
  {
    id: 'gitlab-incoming-mail-token',
    description: 'GitLab incoming mail token (glimt-)',
    pattern: /\bglimt-[A-Za-z0-9_-]{20,}\b/g,
    replacement: '[REDACTED:gitlab-incoming-mail-token]',
  },
  {
    id: 'gitlab-runner-auth-token',
    description: 'GitLab Runner authentication token (glrt-)',
    pattern: /\bglrt-[A-Za-z0-9_-]{20,}\b/g,
    replacement: '[REDACTED:gitlab-runner-auth-token]',
  },
  {
    id: 'gitlab-cicd-job-token',
    description: 'GitLab CI/CD job token (glcbt-)',
    pattern: /\bglcbt-[A-Za-z0-9_-]{20,}\b/g,
    replacement: '[REDACTED:gitlab-cicd-job-token]',
  },
  {
    id: 'gitea-access-token',
    description: 'Gitea access token (40 hex after gitea keyword)',
    pattern: /(gitea[_-]?(?:token|api[_-]?key)\s*[:=]\s*)["']?[a-f0-9]{40}["']?/gi,
    replacement: '$1[REDACTED:gitea-access-token]',
  },
  {
    id: 'bitbucket-app-password',
    description: 'Bitbucket app password / access token (BBDC-)',
    pattern: /\bBBDC-[A-Za-z0-9_-]{32,}\b/g,
    replacement: '[REDACTED:bitbucket-app-password]',
  },
  {
    id: 'azure-devops-pat',
    description: 'Azure DevOps personal access token (52-char base32 after AZURE_DEVOPS keyword)',
    pattern: /(AZURE[_-]?DEVOPS[_A-Z]*\s*[:=]\s*)["']?[a-z0-9]{52}["']?/gi,
    replacement: '$1[REDACTED:azure-devops-pat]',
  },
];
