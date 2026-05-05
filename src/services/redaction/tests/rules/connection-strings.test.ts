import { expect, test } from 'bun:test';

import { applyRedaction } from 'services/redaction';
import { CONNECTION_STRINGS_RULES } from 'services/redaction/rules/connection-strings.ts';

test('redacts password embedded in a postgres URL', () => {
  const input = 'DATABASE_URL=postgresql://alice:supersecret123@db.example.com:5432/app';
  const result = applyRedaction(input, CONNECTION_STRINGS_RULES);
  expect(result.redacted).toContain('[REDACTED:db-connection-password]');
  expect(result.redacted).not.toContain('supersecret123');
  expect(result.redacted).toContain('alice:');
});

test('redacts password embedded in a mysql URL', () => {
  const input = 'DB=mysql://root:adminPass!@localhost:3306/proddb';
  const result = applyRedaction(input, CONNECTION_STRINGS_RULES);
  expect(result.redacted).toContain('[REDACTED:db-connection-password]');
});

test('redacts password embedded in a mongodb+srv URL', () => {
  const input = 'DB_URL=mongodb+srv://app:Pa$$w0rd@cluster0.mongodb.net/db';
  const result = applyRedaction(input, CONNECTION_STRINGS_RULES);
  expect(result.redacted).toContain('[REDACTED:db-connection-password]');
});

test('Stage 2 url-userinfo-credentials catches generic basic-auth URL', () => {
  const input = 'Connecting via https://alice:topsecret123@api.example.com/v1';
  const result = applyRedaction(input, CONNECTION_STRINGS_RULES);
  expect(result.redacted).toContain('[REDACTED:url-credentials]');
  expect(result.redacted).not.toContain('topsecret123');
});

test('redacts password in a kafka connection URL', () => {
  const input = 'KAFKA_URL=kafka://producer:topSecret123@broker:9092/events';
  const result = applyRedaction(input, CONNECTION_STRINGS_RULES);
  expect(result.redacted).toContain('[REDACTED:extended-db-connection-password]');
});

test('redacts password in a clickhouse connection URL', () => {
  const input = 'CH=clickhouse://default:strongPassword@ch.example.com:8123/db';
  const result = applyRedaction(input, CONNECTION_STRINGS_RULES);
  expect(result.redacted).toContain('[REDACTED:extended-db-connection-password]');
});

test('redacts password in a cassandra connection URL', () => {
  const input = 'CASSANDRA=cassandra://app:cassPass@nodeA:9042/keyspace';
  const result = applyRedaction(input, CONNECTION_STRINGS_RULES);
  expect(result.redacted).toContain('[REDACTED:extended-db-connection-password]');
});

test('redacts an LDAP bind password', () => {
  const input = 'LDAP_URL=ldap://cn=admin:bindSecret123@ldap.example.com:389';
  const result = applyRedaction(input, CONNECTION_STRINGS_RULES);
  expect(result.redacted).toContain('[REDACTED:ldap-bind-password]');
});

test('redacts MSSQL Password= field in a connection string', () => {
  const input = 'Server=tcp:db.example.com,1433;User ID=sa;Password=verySecretP@ss123;';
  const result = applyRedaction(input, CONNECTION_STRINGS_RULES);
  expect(result.redacted).toContain('[REDACTED:mssql-password]');
});

test('redacts a JDBC password URL property', () => {
  const input =
    'jdbc.url=jdbc:postgresql://db.example.com:5432/app?user=alice&password=jdbcSecret123';
  const result = applyRedaction(input, CONNECTION_STRINGS_RULES);
  expect(result.redacted).toContain('[REDACTED:jdbc-password]');
});

test('redacts a Snowflake connection URL password', () => {
  const input = 'SF_URL=snowflake://etl_user:snowflakeSecret@xy12345.us-east-1/db';
  const result = applyRedaction(input, CONNECTION_STRINGS_RULES);
  expect(result.redacted).toContain('[REDACTED:snowflake-password]');
});
