import { afterEach, beforeEach, expect, test } from 'bun:test';

import {
  defaultIngestUrl,
  defaultNestBaseUrl,
  defaultVerifyKeyUrl,
  NEST_BASE_URL_DEV,
  NEST_BASE_URL_ENV_VAR,
  NEST_BASE_URL_PROD,
  NODE_ENV_VAR,
} from 'services/config';

let savedOverride: string | undefined;
let savedNodeEnv: string | undefined;

beforeEach(() => {
  savedOverride = process.env[NEST_BASE_URL_ENV_VAR];
  savedNodeEnv = process.env[NODE_ENV_VAR];
  delete process.env[NEST_BASE_URL_ENV_VAR];
  delete process.env[NODE_ENV_VAR];
});

afterEach(() => {
  if (savedOverride === undefined) delete process.env[NEST_BASE_URL_ENV_VAR];
  else process.env[NEST_BASE_URL_ENV_VAR] = savedOverride;
  if (savedNodeEnv === undefined) delete process.env[NODE_ENV_VAR];
  else process.env[NODE_ENV_VAR] = savedNodeEnv;
});

test('defaults to the production Railway URL', () => {
  expect(defaultNestBaseUrl()).toBe(NEST_BASE_URL_PROD);
});

test('switches to localhost:3001 when NODE_ENV=development', () => {
  process.env[NODE_ENV_VAR] = 'development';
  expect(defaultNestBaseUrl()).toBe(NEST_BASE_URL_DEV);
});

test('PROXAI_NEST_URL override beats NODE_ENV=development', () => {
  process.env[NODE_ENV_VAR] = 'development';
  process.env[NEST_BASE_URL_ENV_VAR] = 'http://my-staging.example.com';
  expect(defaultNestBaseUrl()).toBe('http://my-staging.example.com');
});

test('PROXAI_NEST_URL override beats production default', () => {
  process.env[NEST_BASE_URL_ENV_VAR] = 'http://my-staging.example.com';
  expect(defaultNestBaseUrl()).toBe('http://my-staging.example.com');
});

test('strips trailing slash from override', () => {
  process.env[NEST_BASE_URL_ENV_VAR] = 'http://my-staging.example.com/';
  expect(defaultNestBaseUrl()).toBe('http://my-staging.example.com');
});

test('trims whitespace around override', () => {
  process.env[NEST_BASE_URL_ENV_VAR] = '  http://x.example.com  ';
  expect(defaultNestBaseUrl()).toBe('http://x.example.com');
});

test('empty string override falls back to production default', () => {
  process.env[NEST_BASE_URL_ENV_VAR] = '';
  expect(defaultNestBaseUrl()).toBe(NEST_BASE_URL_PROD);
});

test('whitespace-only override falls back to production default', () => {
  process.env[NEST_BASE_URL_ENV_VAR] = '   ';
  expect(defaultNestBaseUrl()).toBe(NEST_BASE_URL_PROD);
});

test('NODE_ENV other than development uses production', () => {
  process.env[NODE_ENV_VAR] = 'production';
  expect(defaultNestBaseUrl()).toBe(NEST_BASE_URL_PROD);
  process.env[NODE_ENV_VAR] = 'staging';
  expect(defaultNestBaseUrl()).toBe(NEST_BASE_URL_PROD);
});

test('defaultIngestUrl appends /v1/raw_records to the base', () => {
  expect(defaultIngestUrl()).toBe(`${NEST_BASE_URL_PROD}/v1/raw_records`);
  process.env[NODE_ENV_VAR] = 'development';
  expect(defaultIngestUrl()).toBe(`${NEST_BASE_URL_DEV}/v1/raw_records`);
});

test('defaultVerifyKeyUrl appends /ingestion/verify-key to the base', () => {
  expect(defaultVerifyKeyUrl()).toBe(`${NEST_BASE_URL_PROD}/ingestion/verify-key`);
  process.env[NODE_ENV_VAR] = 'development';
  expect(defaultVerifyKeyUrl()).toBe(`${NEST_BASE_URL_DEV}/ingestion/verify-key`);
});

test('overrides flow through both endpoint helpers', () => {
  process.env[NEST_BASE_URL_ENV_VAR] = 'http://test.example.com';
  expect(defaultIngestUrl()).toBe('http://test.example.com/v1/raw_records');
  expect(defaultVerifyKeyUrl()).toBe('http://test.example.com/ingestion/verify-key');
});
