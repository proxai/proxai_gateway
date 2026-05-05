import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runInstall } from 'cli/command-install.ts';
import { captureOutput } from 'cli/output.ts';
import { scriptedPrompts } from 'cli/prompts.ts';
import { HttpClient } from 'services/http';
import { loadConfigFromFile } from 'services/config';

let dir: string;
let configPath: string;
let bufferDbPath: string;
let logDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-cli-install-'));
  configPath = join(dir, 'config.toml');
  bufferDbPath = join(dir, 'buffer.db');
  logDir = join(dir, 'logs');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface MockHttpControl {
  validateResponse: 'ok' | 'invalid' | 'auth-error' | 'network-error';
  pinResponse: 'ok' | 'auth-error' | 'network-error';
  validateCalls: number;
  pinCalls: number;
}

function mockFactory(control: MockHttpControl): (apiKey: string, hostId: string) => HttpClient {
  return (apiKey, hostId) =>
    new HttpClient({
      apiKey,
      hostId,
      endpoints: {
        ingest: 'https://api.example.com/v1/raw_records',
        authValidate: 'https://api.example.com/v1/auth/validate',
        health: 'https://api.example.com/v1/health',
        latestVersion: 'https://api.example.com/v1/gateway/latest_version',
        allowedHosts: 'https://api.example.com/v1/api-keys',
      },
      fetch: (async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('auth/validate')) {
          control.validateCalls++;
          if (control.validateResponse === 'ok') {
            return new Response(
              JSON.stringify({ valid: true, account_email: 'a@b.co', error: null }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }
          if (control.validateResponse === 'invalid') {
            return new Response(
              JSON.stringify({ valid: false, account_email: null, error: 'expired' }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }
          if (control.validateResponse === 'auth-error') {
            return new Response('', { status: 403 });
          }
          throw new Error('boom');
        }
        if (url.includes('allowed-hosts')) {
          control.pinCalls++;
          if (control.pinResponse === 'ok') {
            return new Response(JSON.stringify({ allowed_host_ids: [hostId] }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          if (control.pinResponse === 'auth-error') {
            return new Response('', { status: 403 });
          }
          throw new Error('boom');
        }
        return new Response('', { status: 404 });
      }) as unknown as typeof globalThis.fetch,
    });
}

function newControl(overrides: Partial<MockHttpControl> = {}): MockHttpControl {
  return {
    validateResponse: 'ok',
    pinResponse: 'ok',
    validateCalls: 0,
    pinCalls: 0,
    ...overrides,
  };
}

function deps(control: MockHttpControl): Parameters<typeof runInstall>[0] {
  return {
    output: captureOutput(),
    prompts: scriptedPrompts({}),
    configPath,
    bufferDbPath,
    logDir,
    serviceUnitPath: join(dir, 'service.unit'),
    programPath: '/usr/local/bin/proxai-gateway',
    configExists: () => Bun.file(configPath).exists(),
    httpClientFactory: mockFactory(control),
    generateHostId: () => '01943f5a-7b1c-7e92-9c01-a0f3b40d77e3',
    now: () => '2026-04-29T10:42:00.123Z',
    platform: 'linux',
  };
}

test('writes a valid config and reports success on happy path', async () => {
  const control = newControl();
  const result = await runInstall(deps(control), { apiKey: 'pxg_abc' });
  expect(result.exitCode).toBe(0);
  expect(control.validateCalls).toBe(1);
  expect(control.pinCalls).toBe(1);
  const config = await loadConfigFromFile(configPath);
  expect(config.account.apiKey).toBe('pxg_abc');
  expect(config.account.hostId).toBe('01943f5a-7b1c-7e92-9c01-a0f3b40d77e3');
  expect(config.account.installedAt).toBe('2026-04-29T10:42:00.123Z');
  expect(config.capture.bufferPath).toBe(bufferDbPath);
});

test('writes a launchd plist on darwin', async () => {
  const control = newControl();
  const d = deps(control);
  d.platform = 'darwin';
  const result = await runInstall(d, { apiKey: 'pxg_abc' });
  expect(result.exitCode).toBe(0);
  const unitContent = await Bun.file(d.serviceUnitPath as string).text();
  expect(unitContent).toContain('<plist');
  expect(unitContent).toContain('co.proxai.gateway');
});

test('writes a systemd unit on linux', async () => {
  const control = newControl();
  const d = deps(control);
  d.platform = 'linux';
  const result = await runInstall(d, { apiKey: 'pxg_abc' });
  expect(result.exitCode).toBe(0);
  const unitContent = await Bun.file(d.serviceUnitPath as string).text();
  expect(unitContent).toContain('[Service]');
  expect(unitContent).toContain('ExecStart=/usr/local/bin/proxai-gateway');
});

test('skips service unit when serviceUnitPath is null', async () => {
  const control = newControl();
  const d = { ...deps(control), serviceUnitPath: null as string | null };
  const result = await runInstall(d, { apiKey: 'pxg_abc' });
  expect(result.exitCode).toBe(0);
});

test('returns validationError when API key is empty', async () => {
  const control = newControl();
  const result = await runInstall(deps(control), { apiKey: '   ' });
  expect(result.exitCode).toBe(2);
  expect(control.validateCalls).toBe(0);
});

test('returns authError when validate returns invalid', async () => {
  const control = newControl({ validateResponse: 'invalid' });
  const result = await runInstall(deps(control), { apiKey: 'pxg_abc' });
  expect(result.exitCode).toBe(3);
  expect(await Bun.file(configPath).exists()).toBe(false);
});

test('returns authError when validate returns 403', async () => {
  const control = newControl({ validateResponse: 'auth-error' });
  const result = await runInstall(deps(control), { apiKey: 'pxg_abc' });
  expect(result.exitCode).toBe(3);
});

test('returns generic error when validate has network error', async () => {
  const control = newControl({ validateResponse: 'network-error' });
  const result = await runInstall(deps(control), { apiKey: 'pxg_abc' });
  expect(result.exitCode).toBe(1);
});

test('returns generic error when pin host fails', async () => {
  const control = newControl({ pinResponse: 'auth-error' });
  const result = await runInstall(deps(control), { apiKey: 'pxg_abc' });
  expect(result.exitCode).toBe(1);
  expect(await Bun.file(configPath).exists()).toBe(false);
});

test('aborts when existing config and overwrite declined', async () => {
  await writeFile(configPath, 'existing');
  const control = newControl();
  const d = { ...deps(control), prompts: scriptedPrompts({ overwrite: false }) };
  const result = await runInstall(d, { apiKey: 'pxg_abc' });
  expect(result.exitCode).toBe(5);
  expect(control.validateCalls).toBe(0);
});

test('proceeds when existing config and overwrite confirmed', async () => {
  await writeFile(configPath, 'existing');
  const control = newControl();
  const d = { ...deps(control), prompts: scriptedPrompts({ overwrite: true }) };
  const result = await runInstall(d, { apiKey: 'pxg_abc' });
  expect(result.exitCode).toBe(0);
});

test('--yes skips overwrite prompt', async () => {
  await writeFile(configPath, 'existing');
  const control = newControl();
  const result = await runInstall(deps(control), { apiKey: 'pxg_abc', yes: true });
  expect(result.exitCode).toBe(0);
});

test('uses askApiKey prompt when apiKey option not provided', async () => {
  const control = newControl();
  const d = { ...deps(control), prompts: scriptedPrompts({ apiKey: 'pxg_from_prompt' }) };
  const result = await runInstall(d, {});
  expect(result.exitCode).toBe(0);
  const config = await loadConfigFromFile(configPath);
  expect(config.account.apiKey).toBe('pxg_from_prompt');
});

test('honors installSource option', async () => {
  const control = newControl();
  const result = await runInstall(deps(control), {
    apiKey: 'pxg_abc',
    installSource: 'brew',
  });
  expect(result.exitCode).toBe(0);
  const config = await loadConfigFromFile(configPath);
  expect(config.account.installSource).toBe('brew');
});
