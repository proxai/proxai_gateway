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

const VALID_KEY = 'abc123-20260505-secret456';

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
  healthResponse: 'healthy' | 'unhealthy' | 'service-unavailable' | 'network-error';
  healthCalls: number;
}

function mockFactory(control: MockHttpControl): (apiKey: string, hostId: string) => HttpClient {
  return (apiKey, hostId) =>
    new HttpClient({
      apiKey,
      hostId,
      endpoints: {
        ingest: 'https://api.example.com/v1/raw_records',
        health: 'https://api.example.com/health',
      },
      fetch: (async (input: string | URL | Request) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/health')) {
          control.healthCalls++;
          if (control.healthResponse === 'healthy') {
            return new Response(
              JSON.stringify({ status: 'healthy', checks: { db: true, redis: true } }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }
          if (control.healthResponse === 'unhealthy') {
            return new Response(
              JSON.stringify({ status: 'unhealthy', checks: { db: false, redis: true } }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }
          if (control.healthResponse === 'service-unavailable') {
            return new Response('', { status: 503 });
          }
          throw new Error('boom');
        }
        return new Response('', { status: 404 });
      }) as unknown as typeof globalThis.fetch,
    });
}

function newControl(overrides: Partial<MockHttpControl> = {}): MockHttpControl {
  return { healthResponse: 'healthy', healthCalls: 0, ...overrides };
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

test('writes a valid config and reports success on healthy backend', async () => {
  const control = newControl();
  const result = await runInstall(deps(control), { apiKey: VALID_KEY });
  expect(result.exitCode).toBe(0);
  expect(control.healthCalls).toBe(1);
  const config = await loadConfigFromFile(configPath);
  expect(config.account.apiKey).toBe(VALID_KEY);
  expect(config.account.hostId).toBe('01943f5a-7b1c-7e92-9c01-a0f3b40d77e3');
  expect(config.account.installedAt).toBe('2026-04-29T10:42:00.123Z');
  expect(config.capture.bufferPath).toBe(bufferDbPath);
});

test('writes a launchd plist on darwin', async () => {
  const control = newControl();
  const d = deps(control);
  d.platform = 'darwin';
  const result = await runInstall(d, { apiKey: VALID_KEY });
  expect(result.exitCode).toBe(0);
  const unitContent = await Bun.file(d.serviceUnitPath as string).text();
  expect(unitContent).toContain('<plist');
  expect(unitContent).toContain('co.proxai.gateway');
});

test('writes a systemd unit on linux', async () => {
  const control = newControl();
  const d = deps(control);
  d.platform = 'linux';
  const result = await runInstall(d, { apiKey: VALID_KEY });
  expect(result.exitCode).toBe(0);
  const unitContent = await Bun.file(d.serviceUnitPath as string).text();
  expect(unitContent).toContain('[Service]');
  expect(unitContent).toContain('ExecStart=/usr/local/bin/proxai-gateway');
});

test('skips service unit when serviceUnitPath is null', async () => {
  const control = newControl();
  const d = { ...deps(control), serviceUnitPath: null as string | null };
  const result = await runInstall(d, { apiKey: VALID_KEY });
  expect(result.exitCode).toBe(0);
});

test('returns validationError when ingestion key is empty', async () => {
  const control = newControl();
  const result = await runInstall(deps(control), { apiKey: '   ' });
  expect(result.exitCode).toBe(2);
  expect(control.healthCalls).toBe(0);
});

test('returns validationError when ingestion key has wrong format', async () => {
  const control = newControl();
  const result = await runInstall(deps(control), { apiKey: 'not-a-valid-key' });
  expect(result.exitCode).toBe(2);
  expect(control.healthCalls).toBe(0);
});

test('skipKeyFormatCheck bypasses the format gate', async () => {
  const control = newControl();
  const result = await runInstall(deps(control), {
    apiKey: 'free-form-key',
    skipKeyFormatCheck: true,
  });
  expect(result.exitCode).toBe(0);
  expect(control.healthCalls).toBe(1);
});

test('returns error when health endpoint reports unhealthy', async () => {
  const control = newControl({ healthResponse: 'unhealthy' });
  const result = await runInstall(deps(control), { apiKey: VALID_KEY });
  expect(result.exitCode).toBe(1);
  expect(await Bun.file(configPath).exists()).toBe(false);
});

test('returns error when health endpoint returns 503', async () => {
  const control = newControl({ healthResponse: 'service-unavailable' });
  const result = await runInstall(deps(control), { apiKey: VALID_KEY });
  expect(result.exitCode).toBe(1);
  expect(await Bun.file(configPath).exists()).toBe(false);
});

test('returns error on network failure during health check', async () => {
  const control = newControl({ healthResponse: 'network-error' });
  const result = await runInstall(deps(control), { apiKey: VALID_KEY });
  expect(result.exitCode).toBe(1);
});

test('aborts when existing config and overwrite declined', async () => {
  await writeFile(configPath, 'existing');
  const control = newControl();
  const d = { ...deps(control), prompts: scriptedPrompts({ overwrite: false }) };
  const result = await runInstall(d, { apiKey: VALID_KEY });
  expect(result.exitCode).toBe(5);
  expect(control.healthCalls).toBe(0);
});

test('proceeds when existing config and overwrite confirmed', async () => {
  await writeFile(configPath, 'existing');
  const control = newControl();
  const d = { ...deps(control), prompts: scriptedPrompts({ overwrite: true }) };
  const result = await runInstall(d, { apiKey: VALID_KEY });
  expect(result.exitCode).toBe(0);
});

test('--yes skips overwrite prompt', async () => {
  await writeFile(configPath, 'existing');
  const control = newControl();
  const result = await runInstall(deps(control), { apiKey: VALID_KEY, yes: true });
  expect(result.exitCode).toBe(0);
});

test('uses askApiKey prompt when apiKey option not provided', async () => {
  const control = newControl();
  const d = { ...deps(control), prompts: scriptedPrompts({ apiKey: VALID_KEY }) };
  const result = await runInstall(d, {});
  expect(result.exitCode).toBe(0);
  const config = await loadConfigFromFile(configPath);
  expect(config.account.apiKey).toBe(VALID_KEY);
});

test('honors installSource option', async () => {
  const control = newControl();
  const result = await runInstall(deps(control), {
    apiKey: VALID_KEY,
    installSource: 'brew',
  });
  expect(result.exitCode).toBe(0);
  const config = await loadConfigFromFile(configPath);
  expect(config.account.installSource).toBe('brew');
});

test('formatError falls back to String(err) when health throws a non-Error value', async () => {
  const control = newControl();
  const baseDeps = deps(control);
  const output = captureOutput();
  const httpClientFactory = (() =>
    ({
      checkHealth: async () => {
        throw 'plain-string-failure';
      },
    }) as unknown as HttpClient) as unknown as (apiKey: string, hostId: string) => HttpClient;
  const result = await runInstall(
    { ...baseDeps, output, httpClientFactory },
    { apiKey: VALID_KEY },
  );
  expect(result.exitCode).toBe(1);
  const errorLine = output.lines.find((l) => l.level === 'error');
  expect(errorLine?.msg).toContain('health check failed');
  expect(errorLine?.msg).toContain('plain-string-failure');
});
