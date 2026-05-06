import { expect, mock, test } from 'bun:test';

import { inquirerPrompts, scriptedPrompts } from 'cli/prompts.ts';

test('scriptedPrompts.askApiKey returns the configured value (back-compat shim)', async () => {
  const p = scriptedPrompts({ apiKey: 'k123' });
  expect(await p.askApiKey()).toBe('k123');
});

test('scriptedPrompts.askApiKey throws when no apiKey configured', async () => {
  const p = scriptedPrompts({});
  await expect(p.askApiKey()).rejects.toThrow('scripted prompt');
});

test('scriptedPrompts.askApiKey returns successive values from apiKeys queue', async () => {
  const p = scriptedPrompts({ apiKeys: ['k1', 'k2'] });
  expect(await p.askApiKey()).toBe('k1');
  expect(await p.askApiKey()).toBe('k2');
  await expect(p.askApiKey()).rejects.toThrow('scripted prompt');
});

test('inquirerPrompts exposes askApiKey', () => {
  const p = inquirerPrompts();
  expect(typeof p.askApiKey).toBe('function');
});

test('inquirerPrompts.askApiKey wires up to @inquirer/prompts and accepts a custom message', async () => {
  const inputCalls: { message: string; validate?: (v: string) => boolean | string }[] = [];

  await mock.module('@inquirer/prompts', () => ({
    input: (opts: { message: string; validate?: (v: string) => boolean | string }) => {
      inputCalls.push(opts);
      return Promise.resolve('mocked-api-key');
    },
  }));

  const { inquirerPrompts: freshInquirerPrompts } = await import('cli/prompts.ts');
  const p = freshInquirerPrompts();

  const apiKey = await p.askApiKey();
  expect(apiKey).toBe('mocked-api-key');
  expect(inputCalls).toHaveLength(1);
  expect(inputCalls[0]!.message).toBe('Enter your ProxAI ingestion key:');
  const validate = inputCalls[0]!.validate!;
  expect(validate('valid-key')).toBe(true);
  expect(validate('   ')).toBe('ingestion key is required');

  const customMessage = 'Type the same key again to confirm:';
  await p.askApiKey(customMessage);
  expect(inputCalls).toHaveLength(2);
  expect(inputCalls[1]!.message).toBe(customMessage);

  mock.restore();
});
