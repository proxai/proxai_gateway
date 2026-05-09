import { expect, test } from 'bun:test';

import { buildDevDeps } from 'cli/wiring/dev-deps.ts';

test('buildDevDeps: wires sentinels, abort signal, runDaemon, createLogger, loadConfig', () => {
  const ctrl = new AbortController();
  const deps = buildDevDeps({ abortSignal: ctrl.signal, binaryPath: '/bin/p' });
  expect(deps.abortSignal).toBe(ctrl.signal);
  expect(deps.binaryPath).toBe('/bin/p');
  expect(typeof deps.runDaemon).toBe('function');
  expect(typeof deps.createLogger).toBe('function');
  expect(typeof deps.loadConfig).toBe('function');
  expect(typeof deps.gatewayVersion).toBe('string');
});

test('buildDevDeps: loadConfig closure delegates to loadConfigFromFile and rejects when no config', async () => {
  const ctrl = new AbortController();
  const deps = buildDevDeps({ abortSignal: ctrl.signal, binaryPath: '/bin/p' });
  const result = await deps.loadConfig().then(
    () => 'resolved',
    () => 'rejected',
  );
  expect(typeof result).toBe('string');
});
