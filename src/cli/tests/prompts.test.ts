import { expect, test } from 'bun:test';

import { inquirerPrompts, scriptedPrompts } from 'cli/prompts.ts';

test('scriptedPrompts.askApiKey returns the configured value', async () => {
  const p = scriptedPrompts({ apiKey: 'k123' });
  expect(await p.askApiKey()).toBe('k123');
});

test('scriptedPrompts.askApiKey throws when no apiKey configured', async () => {
  const p = scriptedPrompts({});
  await expect(p.askApiKey()).rejects.toThrow('scripted prompt');
});

test('scriptedPrompts.confirmOverwrite returns the configured value', async () => {
  const yes = scriptedPrompts({ overwrite: true });
  const no = scriptedPrompts({ overwrite: false });
  const def = scriptedPrompts({});
  expect(await yes.confirmOverwrite('?')).toBe(true);
  expect(await no.confirmOverwrite('?')).toBe(false);
  expect(await def.confirmOverwrite('?')).toBe(false);
});

test('scriptedPrompts.confirmUninstall returns the configured value', async () => {
  const yes = scriptedPrompts({ uninstall: true });
  const def = scriptedPrompts({});
  expect(await yes.confirmUninstall('?')).toBe(true);
  expect(await def.confirmUninstall('?')).toBe(false);
});

test('inquirerPrompts exposes the three required methods', () => {
  const p = inquirerPrompts();
  expect(typeof p.askApiKey).toBe('function');
  expect(typeof p.confirmOverwrite).toBe('function');
  expect(typeof p.confirmUninstall).toBe('function');
});
