import { afterAll, expect, mock, test } from 'bun:test';
import * as inquirerReal from '@inquirer/prompts';

import { UserAbortedError, requireDefined } from 'core/utils';
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

test('scriptedPrompts.confirmPhrase: boolean shortcut returns the literal answer', async () => {
  const yes = scriptedPrompts({ phrase: true });
  expect(await yes.confirmPhrase('please?', 'uninstall')).toBe(true);
  const no = scriptedPrompts({ phrase: false });
  expect(await no.confirmPhrase('please?', 'uninstall')).toBe(false);
});

test('scriptedPrompts.confirmPhrase: string answer compared to required phrase', async () => {
  const exact = scriptedPrompts({ phrase: 'uninstall' });
  expect(await exact.confirmPhrase('please?', 'uninstall')).toBe(true);
  const wrong = scriptedPrompts({ phrase: 'wrong text' });
  expect(await wrong.confirmPhrase('please?', 'uninstall')).toBe(false);
});

test('scriptedPrompts.confirmPhrase throws when no phrase answer is configured', async () => {
  const p = scriptedPrompts({});
  await expect(p.confirmPhrase('please?', 'uninstall')).rejects.toThrow('scripted prompt');
});

test('scriptedPrompts.confirmUpgrade returns the configured answer', async () => {
  const yes = scriptedPrompts({ upgrade: true });
  expect(await yes.confirmUpgrade('upgrade?')).toBe(true);
  const no = scriptedPrompts({ upgrade: false });
  expect(await no.confirmUpgrade('upgrade?')).toBe(false);
});

test('scriptedPrompts.confirmUpgrade throws when no upgrade answer is configured', async () => {
  const p = scriptedPrompts({});
  await expect(p.confirmUpgrade('upgrade?')).rejects.toThrow('scripted prompt');
});

test('inquirerPrompts.confirmPhrase: typing the exact phrase resolves to true', async () => {
  const inputCalls: { message: string }[] = [];
  await mock.module('@inquirer/prompts', () => ({
    confirm: () => Promise.resolve(true),
    input: (opts: { message: string }) => {
      inputCalls.push(opts);
      return Promise.resolve('  uninstall  ');
    },
  }));
  const { inquirerPrompts: fresh } = await import('cli/prompts.ts');
  expect(await fresh().confirmPhrase('Type uninstall:', 'uninstall')).toBe(true);
  expect(inputCalls).toHaveLength(1);
  expect(requireDefined(inputCalls[0]).message).toBe('Type uninstall:');
  mock.restore();
});

test('inquirerPrompts.confirmPhrase: any non-matching input aborts (false)', async () => {
  await mock.module('@inquirer/prompts', () => ({
    confirm: () => Promise.resolve(true),
    input: () => Promise.resolve('nope'),
  }));
  const { inquirerPrompts: fresh } = await import('cli/prompts.ts');
  expect(await fresh().confirmPhrase('Type uninstall:', 'uninstall')).toBe(false);
  mock.restore();
});

test('inquirerPrompts.confirmPhrase: empty submission resolves to false (abort)', async () => {
  await mock.module('@inquirer/prompts', () => ({
    confirm: () => Promise.resolve(true),
    input: () => Promise.resolve(''),
  }));
  const { inquirerPrompts: fresh } = await import('cli/prompts.ts');
  expect(await fresh().confirmPhrase('Type uninstall:', 'uninstall')).toBe(false);
  mock.restore();
});

test('inquirerPrompts.confirmUpgrade wires up to @inquirer/prompts confirm with default true', async () => {
  const calls: { message: string; default?: boolean }[] = [];
  await mock.module('@inquirer/prompts', () => ({
    confirm: (opts: { message: string; default?: boolean }) => {
      calls.push(opts);
      return Promise.resolve(true);
    },
    input: () => Promise.resolve('unused'),
  }));
  const { inquirerPrompts: fresh } = await import('cli/prompts.ts');
  expect(await fresh().confirmUpgrade('upgrade?')).toBe(true);
  expect(calls).toHaveLength(1);
  expect(requireDefined(calls[0]).message).toBe('upgrade?');
  expect(requireDefined(calls[0]).default).toBe(true);
  mock.restore();
});

test('inquirerPrompts.askApiKey converts ExitPromptError (Ctrl+C) to UserAbortedError', async () => {
  await mock.module('@inquirer/prompts', () => ({
    confirm: () => Promise.resolve(true),
    input: () => {
      const err = new Error('User force closed the prompt with SIGINT');
      err.name = 'ExitPromptError';
      throw err;
    },
  }));
  const { inquirerPrompts: fresh } = await import('cli/prompts.ts');
  await expect(fresh().askApiKey()).rejects.toBeInstanceOf(UserAbortedError);
  mock.restore();
});

test('inquirerPrompts.confirmPhrase converts AbortPromptError to UserAbortedError', async () => {
  await mock.module('@inquirer/prompts', () => ({
    confirm: () => Promise.resolve(true),
    input: () => {
      const err = new Error('aborted');
      err.name = 'AbortPromptError';
      throw err;
    },
  }));
  const { inquirerPrompts: fresh } = await import('cli/prompts.ts');
  await expect(fresh().confirmPhrase('Type x:', 'x')).rejects.toBeInstanceOf(UserAbortedError);
  mock.restore();
});

test('inquirerPrompts.confirmUpgrade converts CancelPromptError to UserAbortedError', async () => {
  await mock.module('@inquirer/prompts', () => ({
    confirm: () => {
      const err = new Error('cancelled');
      err.name = 'CancelPromptError';
      throw err;
    },
    input: () => Promise.resolve('unused'),
  }));
  const { inquirerPrompts: fresh } = await import('cli/prompts.ts');
  await expect(fresh().confirmUpgrade('upgrade?')).rejects.toBeInstanceOf(UserAbortedError);
  mock.restore();
});

test('inquirerPrompts.askApiKey detects abort by message text when error name is generic', async () => {
  await mock.module('@inquirer/prompts', () => ({
    confirm: () => Promise.resolve(true),
    input: () => {
      throw new Error('User force closed the prompt with SIGINT');
    },
  }));
  const { inquirerPrompts: fresh } = await import('cli/prompts.ts');
  await expect(fresh().askApiKey()).rejects.toBeInstanceOf(UserAbortedError);
  mock.restore();
});

test('inquirerPrompts.askApiKey rethrows non-abort errors unchanged', async () => {
  await mock.module('@inquirer/prompts', () => ({
    confirm: () => Promise.resolve(true),
    input: () => {
      throw new Error('something else broke');
    },
  }));
  const { inquirerPrompts: fresh } = await import('cli/prompts.ts');
  await expect(fresh().askApiKey()).rejects.toThrow('something else broke');
  mock.restore();
});

test('inquirerPrompts.askApiKey rethrows non-Error throws unchanged', async () => {
  await mock.module('@inquirer/prompts', () => ({
    confirm: () => Promise.resolve(true),
    input: () => {
      throw 'string-error';
    },
  }));
  const { inquirerPrompts: fresh } = await import('cli/prompts.ts');
  await expect(fresh().askApiKey()).rejects.toBe('string-error');
  mock.restore();
});

test('UserAbortedError has the expected default message', () => {
  const err = new UserAbortedError();
  expect(err.name).toBe('UserAbortedError');
  expect(err.message).toBe('aborted by user');
});

test('UserAbortedError accepts a custom message', () => {
  const err = new UserAbortedError('custom abort');
  expect(err.message).toBe('custom abort');
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
  expect(requireDefined(inputCalls[0]).message).toBe('Enter your ProxAI gateway key:');
  const validate = requireDefined(requireDefined(inputCalls[0]).validate);
  expect(validate('valid-key')).toBe(true);
  expect(validate('   ')).toBe('gateway key is required');

  const customMessage = 'Type the same key again to confirm:';
  await p.askApiKey(customMessage);
  expect(inputCalls).toHaveLength(2);
  expect(requireDefined(inputCalls[1]).message).toBe(customMessage);

  mock.restore();
});

test('inquirerPrompts.confirmReplace wires up to @inquirer/prompts confirm with default false', async () => {
  const calls: { message: string; default?: boolean }[] = [];
  await mock.module('@inquirer/prompts', () => ({
    confirm: (opts: { message: string; default?: boolean }) => {
      calls.push(opts);
      return Promise.resolve(false);
    },
    input: () => Promise.resolve('unused'),
  }));
  const { inquirerPrompts: fresh } = await import('cli/prompts.ts');
  expect(await fresh().confirmReplace('replace?')).toBe(false);
  expect(calls).toHaveLength(1);
  expect(requireDefined(calls[0]).message).toBe('replace?');
  expect(requireDefined(calls[0]).default).toBe(false);
  mock.restore();
});

test('inquirerPrompts.askProfile wires up to @inquirer/prompts select', async () => {
  const calls: { message: string; choices: { name: string; value: string }[] }[] = [];
  await mock.module('@inquirer/prompts', () => ({
    select: (opts: { message: string; choices: { name: string; value: string }[] }) => {
      calls.push(opts);
      return Promise.resolve('dev');
    },
    input: () => Promise.resolve('unused'),
  }));
  const { inquirerPrompts: fresh } = await import('cli/prompts.ts');
  expect(await fresh().askProfile()).toBe('dev');
  expect(calls).toHaveLength(1);
  expect(requireDefined(calls[0]).message).toBe('Select the environment profile to configure:');
  mock.restore();
});

test('scriptedPrompts.confirmReplace returns configured answer or throws', async () => {
  const yes = scriptedPrompts({ replace: true });
  expect(await yes.confirmReplace('replace?')).toBe(true);
  const no = scriptedPrompts({ replace: false });
  expect(await no.confirmReplace('replace?')).toBe(false);
  const empty = scriptedPrompts({});
  await expect(empty.confirmReplace('replace?')).rejects.toThrow('scripted prompt');
});

test('scriptedPrompts.askProfile returns configured answer or throws', async () => {
  const dev = scriptedPrompts({ profile: 'dev' });
  expect(await dev.askProfile()).toBe('dev');
  const prod = scriptedPrompts({ profile: 'prod' });
  expect(await prod.askProfile()).toBe('prod');
  const empty = scriptedPrompts({});
  await expect(empty.askProfile()).rejects.toThrow('scripted prompt');
});

test('inquirerPrompts.askApiKey detects abort by message text with "user force"', async () => {
  await mock.module('@inquirer/prompts', () => ({
    confirm: () => Promise.resolve(true),
    input: () => {
      throw new Error('user force killed it');
    },
  }));
  const { inquirerPrompts: fresh } = await import('cli/prompts.ts');
  await expect(fresh().askApiKey()).rejects.toBeInstanceOf(UserAbortedError);
  mock.restore();
});

afterAll(() => {
  mock.module('@inquirer/prompts', () => inquirerReal);
});
