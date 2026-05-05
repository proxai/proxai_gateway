import { expect, test } from 'bun:test';

import { resolveNestBaseUrl } from 'services/config';

test('defaults to the production Railway URL', () => {
  expect(resolveNestBaseUrl({})).toBe('https://proxainest-production.up.railway.app');
});

test('uses localhost:3001 when NODE_ENV=development', () => {
  expect(resolveNestBaseUrl({ NODE_ENV: 'development' })).toBe('http://localhost:3001');
});

test('PROXAI_NEST_URL override beats both defaults', () => {
  expect(resolveNestBaseUrl({ PROXAI_NEST_URL: 'http://staging.example.com' })).toBe(
    'http://staging.example.com',
  );
  expect(
    resolveNestBaseUrl({
      NODE_ENV: 'development',
      PROXAI_NEST_URL: 'http://staging.example.com',
    }),
  ).toBe('http://staging.example.com');
});

test('strips trailing slash and surrounding whitespace from override', () => {
  expect(resolveNestBaseUrl({ PROXAI_NEST_URL: '  http://x.example.com/  ' })).toBe(
    'http://x.example.com',
  );
});

test('empty or whitespace-only override falls back to production', () => {
  expect(resolveNestBaseUrl({ PROXAI_NEST_URL: '' })).toBe(
    'https://proxainest-production.up.railway.app',
  );
  expect(resolveNestBaseUrl({ PROXAI_NEST_URL: '   ' })).toBe(
    'https://proxainest-production.up.railway.app',
  );
});

test('NODE_ENV other than development uses production', () => {
  expect(resolveNestBaseUrl({ NODE_ENV: 'production' })).toBe(
    'https://proxainest-production.up.railway.app',
  );
  expect(resolveNestBaseUrl({ NODE_ENV: 'staging' })).toBe(
    'https://proxainest-production.up.railway.app',
  );
});
