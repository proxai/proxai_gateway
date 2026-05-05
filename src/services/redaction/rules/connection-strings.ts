import type { RedactionRule } from 'services/redaction/redaction.types.ts';

export const CONNECTION_STRINGS_RULES: readonly RedactionRule[] = [
  {
    id: 'database-connection-password',
    description:
      'Password embedded in a typed DB connection URL (postgres, mysql, mongodb, redis, amqp)',
    pattern:
      /\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|amqps):\/\/[^:/\s]+:)[^@\s]+(@)/g,
    replacement: '$1[REDACTED:db-connection-password]$2',
    stage: 1,
  },
  {
    id: 'url-userinfo-credentials',
    description: 'Generic basic credentials embedded in a URL (Stage 2 fallback)',
    pattern: /\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:/\s@]+:)[^@\s[\]]{4,}(@)/g,
    replacement: '$1[REDACTED:url-credentials]$2',
    stage: 2,
  },
];
