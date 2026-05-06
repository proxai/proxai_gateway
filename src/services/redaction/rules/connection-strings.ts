import type { RedactionRule } from 'services/redaction/redaction.types.ts';

export const CONNECTION_STRINGS_RULES: readonly RedactionRule[] = [
  {
    id: 'database-connection-password',
    description:
      'Password embedded in a typed DB connection URL (postgres, mysql, mongodb, redis, amqp)',
    pattern:
      /\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|amqps):\/\/[^:/\s]+:)[^@\s]+(@)/g,
    replacement: '$1[REDACTED:db-connection-password]$2',
  },
  {
    id: 'url-userinfo-credentials',
    description: 'Generic basic credentials embedded in a URL (Stage 2 fallback)',
    pattern: /\b([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:/\s@]+:)[^@\s[\]]{4,}(@)/g,
    replacement: '$1[REDACTED:url-credentials]$2',
  },
  {
    id: 'extended-db-connection-password',
    description:
      'Password embedded in extended DB connection URL (kafka, cassandra, clickhouse, mssql, sqlserver, oracle, jdbc)',
    pattern:
      /\b((?:kafka|cassandra|clickhouse|mssql|sqlserver|oracle|jdbc:[a-z]+):\/\/[^:/\s]+:)[^@\s]+(@)/g,
    replacement: '$1[REDACTED:extended-db-connection-password]$2',
  },
  {
    id: 'ldap-bind-password',
    description: 'LDAP bind password (ldap:// URL with userinfo)',
    pattern: /\b(ldaps?:\/\/[^:/\s]+:)[^@\s]+(@)/g,
    replacement: '$1[REDACTED:ldap-bind-password]$2',
  },
  {
    id: 'mssql-server-connection-string-password',
    description: 'MSSQL connection string Password= field (within a connection string)',
    pattern: /(;\s*(?:Pwd|Password)\s*=\s*)[^;\n"']+(?=;|$|"|')/gi,
    replacement: '$1[REDACTED:mssql-password]',
  },
  {
    id: 'jdbc-password-property',
    description: 'JDBC URL with embedded password property (?password= or &password=)',
    pattern: /([?&]password=)[^&\s"']{4,}/gi,
    replacement: '$1[REDACTED:jdbc-password]',
  },
  {
    id: 'snowflake-connection-string-password',
    description: 'Snowflake-style connection password attribute',
    pattern: /\b(snowflake:\/\/[^:/\s]+:)[^@\s]+(@)/g,
    replacement: '$1[REDACTED:snowflake-password]$2',
  },
];
