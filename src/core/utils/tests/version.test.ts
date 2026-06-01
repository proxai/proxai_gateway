import { expect, test } from 'bun:test';

import { compareGatewayVersions } from 'core/utils/version.ts';

test('orders CalVer date components', () => {
  expect(compareGatewayVersions('2026.5.10', '2026.5.7')).toBe(1);
  expect(compareGatewayVersions('2026.5.7', '2026.5.10')).toBe(-1);
  expect(compareGatewayVersions('2026.5.7', '2026.5.7')).toBe(0);
  expect(compareGatewayVersions('2026.6.1', '2026.5.31')).toBe(1);
});

test('treats a same-day hyphen suffix as a later release than the bare date', () => {
  expect(compareGatewayVersions('2026.6.1-1', '2026.6.1')).toBe(1);
  expect(compareGatewayVersions('2026.6.1-2', '2026.6.1')).toBe(1);
  expect(compareGatewayVersions('2026.6.1-2', '2026.6.1-1')).toBe(1);
  expect(compareGatewayVersions('2026.6.1', '2026.6.1-2')).toBe(-1);
  expect(compareGatewayVersions('2026.6.1-1', '2026.6.1-2')).toBe(-1);
  expect(compareGatewayVersions('2026.6.1-2', '2026.6.1-2')).toBe(0);
});

test('a newer date outranks any same-day suffix on an older date', () => {
  expect(compareGatewayVersions('2026.6.2', '2026.6.1-9')).toBe(1);
  expect(compareGatewayVersions('2026.6.1-9', '2026.6.2')).toBe(-1);
});

test('tolerates a leading v prefix stripped upstream and non-finite segments', () => {
  expect(compareGatewayVersions('2026.abc', '2026.5')).toBe(-1);
  expect(compareGatewayVersions('2026.5.abc', '2026.5')).toBe(0);
  expect(compareGatewayVersions('2026.6.1-', '2026.6.1')).toBe(0);
});
