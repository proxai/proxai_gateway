import { expect, test } from 'bun:test';

import { getServiceManager } from 'cli/service-manager';

test('unsupported platform throws clear error', () => {
  expect(() =>
    getServiceManager({
      platform: 'aix' as NodeJS.Platform,
      unitPath: '/x',
    }),
  ).toThrow(/unsupported platform/);
});
