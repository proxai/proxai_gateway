import { expect, mock, test } from 'bun:test';

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

test('inquirerPrompts wires up askApiKey, confirmOverwrite, confirmUninstall to @inquirer/prompts', async () => {
  const inputCalls: { message: string; validate?: (v: string) => boolean | string }[] = [];
  const confirmCalls: { message: string; default?: boolean }[] = [];

  await mock.module('@inquirer/prompts', () => ({
    input: (opts: { message: string; validate?: (v: string) => boolean | string }) => {
      inputCalls.push(opts);
      return Promise.resolve('mocked-api-key');
    },
    confirm: (opts: { message: string; default?: boolean }) => {
      confirmCalls.push(opts);
      return Promise.resolve(true);
    },
  }));

  const { inquirerPrompts: freshInquirerPrompts } = await import('cli/prompts.ts');
  const p = freshInquirerPrompts();

  const apiKey = await p.askApiKey();
  expect(apiKey).toBe('mocked-api-key');
  expect(inputCalls).toHaveLength(1);
  expect(inputCalls[0]!.message).toBe('Enter your ProxAI API key:');
  const validate = inputCalls[0]!.validate!;
  expect(validate('valid-key')).toBe(true);
  expect(validate('   ')).toBe('API key is required');

  const overwrite = await p.confirmOverwrite('overwrite?');
  expect(overwrite).toBe(true);
  expect(confirmCalls).toHaveLength(1);
  expect(confirmCalls[0]!.message).toBe('overwrite?');
  expect(confirmCalls[0]!.default).toBe(false);

  const uninstall = await p.confirmUninstall('uninstall?');
  expect(uninstall).toBe(true);
  expect(confirmCalls).toHaveLength(2);
  expect(confirmCalls[1]!.message).toBe('uninstall?');
  expect(confirmCalls[1]!.default).toBe(false);

  mock.restore();
});
