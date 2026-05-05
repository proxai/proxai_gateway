import type { RedactionRule } from 'services/redaction/redaction.types.ts';

export const SOURCE_CONTROL_RULES: readonly RedactionRule[] = [
  {
    id: 'github-fine-grained-pat',
    description: 'GitHub fine-grained personal access token (github_pat_)',
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    replacement: '[REDACTED:github-fine-grained-pat]',
    stage: 1,
  },
  {
    id: 'github-pat',
    description: 'GitHub personal / OAuth / app token (gh[pours]_)',
    pattern: /\bgh[pours]_[A-Za-z0-9]{30,}\b/g,
    replacement: '[REDACTED:github-pat]',
    stage: 1,
  },
  {
    id: 'gitlab-pat',
    description: 'GitLab personal access token (glpat-)',
    pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
    replacement: '[REDACTED:gitlab-pat]',
    stage: 1,
  },
  {
    id: 'gitlab-pipeline-trigger-token',
    description: 'GitLab pipeline trigger token (glptt-)',
    pattern: /\bglptt-[A-Za-z0-9_-]{20,}\b/g,
    replacement: '[REDACTED:gitlab-pipeline-trigger-token]',
    stage: 1,
  },
];
