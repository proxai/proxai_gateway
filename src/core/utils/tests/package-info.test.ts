import { expect, test } from 'bun:test';

import { GATEWAY_USER_AGENT, PACKAGE_DESCRIPTION, PACKAGE_NAME, PACKAGE_VERSION } from 'core/utils';

test('PACKAGE_NAME is the gateway npm name', () => {
  expect(PACKAGE_NAME).toBe('@proxai/gateway');
});

test('PACKAGE_VERSION is a CalVer string YYYY.M.D', () => {
  expect(PACKAGE_VERSION).toMatch(/^\d{4}\.\d{1,2}\.\d{1,2}(-\d+)?$/);
});

test('PACKAGE_DESCRIPTION is non-empty', () => {
  expect(typeof PACKAGE_DESCRIPTION).toBe('string');
  expect(PACKAGE_DESCRIPTION.length).toBeGreaterThan(0);
});

test('GATEWAY_USER_AGENT combines name and version', () => {
  expect(GATEWAY_USER_AGENT).toBe(`${PACKAGE_NAME} ${PACKAGE_VERSION}`);
});
