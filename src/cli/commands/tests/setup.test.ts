import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rmRecursive } from 'core/io/fs';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSetup } from 'cli/commands/setup.ts';
import { captureOutput } from 'cli/output.ts';
import { scriptedPrompts } from 'cli/prompts.ts';
import { deriveHostId } from 'core/system';
import { HttpClient } from 'services/http';
import {
  loadConfigFromFile,
  writeConfigToFile,
  NEST_INGEST_URL,
  NEST_VERIFY_KEY_URL,
  DEFAULT_BUFFER_SOFT_PAUSE_BYTES,
  DEFAULT_BUFFER_SOFT_RESUME_BYTES,
  DEFAULT_FAILED_RETENTION_DAYS,
  DEFAULT_INITIAL_SCAN_WINDOW_DAYS,
  DEFAULT_POLL_INTERVAL_SEC,
  DEFAULT_RECEIPT_RETENTION_DAYS,
  DEFAULT_STALE_PAUSE_DAYS,
  DEFAULT_STALE_WARN_DAYS,
  DEFAULT_UPLOAD_BACKOFF_ON_429_MULTIPLIER,
  DEFAULT_UPLOAD_MAX_BATCHES_PER_SEC,
  DEFAULT_UPLOAD_MAX_BYTES_PER_MINUTE,
} from 'services/config';
import type { GatewayConfig } from 'services/config';

const TEST_MACHINE_UUID = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
const TEST_USER_ID = 'u_1';
const TEST_USER_ID_OTHER = 'u_2';
const EXPECTED_HOST_ID = deriveHostId(TEST_MACHINE_UUID, TEST_USER_ID);
const EXPECTED_HOST_ID_OTHER = deriveHostId(TEST_MACHINE_UUID, TEST_USER_ID_OTHER);

let dir: string;
let configPath: string;
let bufferDbPath: string;
let logDir: string;

const VALID_KEY = 'abc123-20260505-secret456';
const NEW_KEY = 'def789-20260601-newsecret123';
const OTHER_KEY = 'xyz000-20260701-mismatchkey99';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'proxai-cli-setup-'));
  configPath = join(dir, 'config.toml');
  bufferDbPath = join(dir, 'buffer.db');
  logDir = join(dir, 'logs');
});

afterEach(async () => {
  await rmRecursive(dir);
});

interface MockHttpControl {
  verifyResponse: 'accepted' | 'rejected' | 'forbidden' | 'service-unavailable' | 'network-error';
  userId: string;
  verifyCalls: number;
  registerResponse:
    | 'registered'
    | 'idempotent'
    | 'forbidden'
    | 'service-unavailable'
    | 'network-error';
  registerCalls: number;
  registerLastBody: { host_id?: string } | null;
}

function mockFactory(control: MockHttpControl): (apiKey: string, hostId: string) => HttpClient {
  return (apiKey, hostId) =>
    new HttpClient({
      apiKey,
      hostId,
      endpoints: {
        ingest: 'https://api.example.com/v1/raw_records',
        verifyKey: 'https://api.example.com/ingestion/verify-key',
        watermarks: 'https://api.example.com/v1/watermarks',
        registerHostId: 'https://api.example.com/v1/host-ids/register',
      },
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/ingestion/verify-key')) {
          control.verifyCalls++;
          if (control.verifyResponse === 'accepted') {
            return new Response(
              JSON.stringify({
                success: true,
                data: { keyName: 'my-key', userId: control.userId },
                message: 'Key verified successfully',
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }
          if (control.verifyResponse === 'rejected') {
            return new Response(JSON.stringify({ success: false, message: 'key expired' }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          }
          if (control.verifyResponse === 'forbidden') {
            return new Response('', { status: 403 });
          }
          if (control.verifyResponse === 'service-unavailable') {
            return new Response('', { status: 503 });
          }
          throw new Error('boom');
        }
        if (url.includes('/v1/host-ids/register')) {
          control.registerCalls++;
          control.registerLastBody =
            init?.body === undefined
              ? null
              : (JSON.parse(init.body as string) as { host_id?: string });
          if (control.registerResponse === 'registered') {
            return new Response(
              JSON.stringify({
                host_id: control.registerLastBody?.host_id ?? '',
                user_id: control.userId,
                registered: true,
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }
          if (control.registerResponse === 'idempotent') {
            return new Response(
              JSON.stringify({
                host_id: control.registerLastBody?.host_id ?? '',
                user_id: control.userId,
                registered: false,
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } },
            );
          }
          if (control.registerResponse === 'forbidden') {
            return new Response('', { status: 403 });
          }
          if (control.registerResponse === 'service-unavailable') {
            return new Response('', { status: 503 });
          }
          throw new Error('boom-register');
        }
        return new Response('', { status: 404 });
      }) as unknown as typeof globalThis.fetch,
    });
}

function newControl(overrides: Partial<MockHttpControl> = {}): MockHttpControl {
  return {
    verifyResponse: 'accepted',
    userId: TEST_USER_ID,
    verifyCalls: 0,
    registerResponse: 'registered',
    registerCalls: 0,
    registerLastBody: null,
    ...overrides,
  };
}

function deps(control: MockHttpControl): Parameters<typeof runSetup>[0] {
  return {
    output: captureOutput(),
    prompts: scriptedPrompts({}),
    configPath,
    bufferDbPath,
    logDir,
    authFailedSentinelPath: join(dir, 'AUTH_FAILED'),
    serviceUnitPath: join(dir, 'service.unit'),
    programPath: '/usr/local/bin/proxai-gateway',
    configExists: () => Bun.file(configPath).exists(),
    httpClientFactory: mockFactory(control),
    readMachineUuid: async () => TEST_MACHINE_UUID,
    now: () => '2026-04-29T10:42:00.123Z',
    platform: 'linux',
  };
}

async function writeExistingConfig(
  overrides: Partial<GatewayConfig['account']> = {},
): Promise<void> {
  const config: GatewayConfig = {
    account: {
      apiKey: VALID_KEY,
      userId: TEST_USER_ID,
      hostId: EXPECTED_HOST_ID,
      installedAt: '2026-04-29T10:42:00.123Z',
      installSource: 'github_release',
      ...overrides,
    },
    backend: {
      ingestUrl: NEST_INGEST_URL,
      verifyKeyUrl: NEST_VERIFY_KEY_URL,
      watermarksUrl: 'https://api.example.com/v1/watermarks',
      registerHostIdUrl: 'https://api.example.com/v1/host-ids/register',
    },
    capture: {
      pollIntervalSec: DEFAULT_POLL_INTERVAL_SEC,
      bufferPath: bufferDbPath,
      receiptRetentionDays: DEFAULT_RECEIPT_RETENTION_DAYS,
      failedRetentionDays: DEFAULT_FAILED_RETENTION_DAYS,
      bufferSoftPauseBytes: DEFAULT_BUFFER_SOFT_PAUSE_BYTES,
      bufferSoftResumeBytes: DEFAULT_BUFFER_SOFT_RESUME_BYTES,
      initialScanWindowDays: DEFAULT_INITIAL_SCAN_WINDOW_DAYS,
      uploadMaxBatchesPerSec: DEFAULT_UPLOAD_MAX_BATCHES_PER_SEC,
      uploadMaxBytesPerMinute: DEFAULT_UPLOAD_MAX_BYTES_PER_MINUTE,
      uploadBackoffOn429Multiplier: DEFAULT_UPLOAD_BACKOFF_ON_429_MULTIPLIER,
    },
    logging: { level: 'info', logDir },
    staleBinary: {
      warnAfterDays: DEFAULT_STALE_WARN_DAYS,
      pauseAfterDays: DEFAULT_STALE_PAUSE_DAYS,
    },
  };
  await writeConfigToFile(config, configPath);
}

test('writes a valid config and reports success when key is accepted', async () => {
  const control = newControl();
  const result = await runSetup(deps(control), { apiKey: VALID_KEY });
  expect(result.exitCode).toBe(0);
  expect(control.verifyCalls).toBe(1);
  const config = await loadConfigFromFile(configPath);
  expect(config.account.apiKey).toBe(VALID_KEY);
  expect(config.account.userId).toBe(TEST_USER_ID);
  expect(config.account.hostId).toBe(EXPECTED_HOST_ID);
  expect(config.account.hostId).toMatch(/^[0-9a-f]{64}$/);
  expect(config.account.installedAt).toBe('2026-04-29T10:42:00.123Z');
  expect(config.capture.bufferPath).toBe(bufferDbPath);
});

test('writes a launchd plist on darwin', async () => {
  const control = newControl();
  const d = deps(control);
  d.platform = 'darwin';
  const result = await runSetup(d, { apiKey: VALID_KEY });
  expect(result.exitCode).toBe(0);
  const unitContent = await Bun.file(d.serviceUnitPath as string).text();
  expect(unitContent).toContain('<plist');
  expect(unitContent).toContain('co.proxai.gateway');
});

test('writes a systemd unit on linux', async () => {
  const control = newControl();
  const d = deps(control);
  d.platform = 'linux';
  const result = await runSetup(d, { apiKey: VALID_KEY });
  expect(result.exitCode).toBe(0);
  const unitContent = await Bun.file(d.serviceUnitPath as string).text();
  expect(unitContent).toContain('[Service]');
  expect(unitContent).toContain('ExecStart=/usr/local/bin/proxai-gateway');
});

test('writes a scheduled-task XML on win32 with the configured user id', async () => {
  const control = newControl();
  const d = deps(control);
  d.platform = 'win32';
  d.windowsUserId = 'MYDOMAIN\\testuser';
  const result = await runSetup(d, { apiKey: VALID_KEY });
  expect(result.exitCode).toBe(0);

  const bytes = await Bun.file(d.serviceUnitPath as string).bytes();

  expect(bytes[0]).toBe(0xff);
  expect(bytes[1]).toBe(0xfe);
  const unitContent = Buffer.from(
    bytes.buffer,
    bytes.byteOffset + 2,
    bytes.byteLength - 2,
  ).toString('utf16le');
  expect(unitContent).toContain('<Task ');
  expect(unitContent).toContain('MYDOMAIN\\testuser');
  expect(unitContent).toContain('<Command>/usr/local/bin/proxai-gateway</Command>');
});

test('skips service unit when serviceUnitPath is null', async () => {
  const control = newControl();
  const d = { ...deps(control), serviceUnitPath: null as string | null };
  const result = await runSetup(d, { apiKey: VALID_KEY });
  expect(result.exitCode).toBe(0);
});

test('returns validationError when ingestion key is empty', async () => {
  const control = newControl();
  const result = await runSetup(deps(control), { apiKey: '   ' });
  expect(result.exitCode).toBe(2);
  expect(control.verifyCalls).toBe(0);
});

test('returns validationError when ingestion key has wrong format', async () => {
  const control = newControl();
  const result = await runSetup(deps(control), { apiKey: 'not-a-valid-key' });
  expect(result.exitCode).toBe(2);
  expect(control.verifyCalls).toBe(0);
});

test('skipKeyFormatCheck bypasses the format gate', async () => {
  const control = newControl();
  const result = await runSetup(deps(control), {
    apiKey: 'free-form-key',
    skipKeyFormatCheck: true,
  });
  expect(result.exitCode).toBe(0);
  expect(control.verifyCalls).toBe(1);
});

test('returns authError when verify-key returns success: false', async () => {
  const control = newControl({ verifyResponse: 'rejected' });
  const result = await runSetup(deps(control), { apiKey: VALID_KEY });
  expect(result.exitCode).toBe(3);
  expect(await Bun.file(configPath).exists()).toBe(false);
});

test('returns authError when verify-key returns 403', async () => {
  const control = newControl({ verifyResponse: 'forbidden' });
  const result = await runSetup(deps(control), { apiKey: VALID_KEY });
  expect(result.exitCode).toBe(3);
  expect(await Bun.file(configPath).exists()).toBe(false);
});

test('returns generic error when verify-key returns 503', async () => {
  const control = newControl({ verifyResponse: 'service-unavailable' });
  const result = await runSetup(deps(control), { apiKey: VALID_KEY });
  expect(result.exitCode).toBe(1);
});

test('returns generic error on network failure during verify-key', async () => {
  const control = newControl({ verifyResponse: 'network-error' });
  const result = await runSetup(deps(control), { apiKey: VALID_KEY });
  expect(result.exitCode).toBe(1);
});

test('uses askApiKey prompt when apiKey option not provided', async () => {
  const control = newControl();
  const d = { ...deps(control), prompts: scriptedPrompts({ apiKey: VALID_KEY }) };
  const result = await runSetup(d, {});
  expect(result.exitCode).toBe(0);
  const config = await loadConfigFromFile(configPath);
  expect(config.account.apiKey).toBe(VALID_KEY);
});

test('honors installSource option', async () => {
  const control = newControl();
  const result = await runSetup(deps(control), {
    apiKey: VALID_KEY,
    installSource: 'brew',
  });
  expect(result.exitCode).toBe(0);
  const config = await loadConfigFromFile(configPath);
  expect(config.account.installSource).toBe('brew');
});

test('formatError falls back to String(err) when verify-key throws a non-Error value', async () => {
  const control = newControl();
  const baseDeps = deps(control);
  const output = captureOutput();
  const httpClientFactory = (() =>
    ({
      verifyKey: async () => {
        throw 'plain-string-failure';
      },
    }) as unknown as HttpClient) as unknown as (apiKey: string, hostId: string) => HttpClient;
  const result = await runSetup({ ...baseDeps, output, httpClientFactory }, { apiKey: VALID_KEY });
  expect(result.exitCode).toBe(1);
  const errorLine = output.lines.find((l) => l.level === 'error');
  expect(errorLine?.msg).toContain('verify-key failed');
  expect(errorLine?.msg).toContain('plain-string-failure');
});

test('reports server-provided message when key is rejected with reason', async () => {
  const control = newControl({ verifyResponse: 'rejected' });
  const baseDeps = deps(control);
  const output = captureOutput();
  const result = await runSetup({ ...baseDeps, output }, { apiKey: VALID_KEY });
  expect(result.exitCode).toBe(3);
  const errorLine = output.lines.find((l) => l.level === 'error');
  expect(errorLine?.msg).toContain('key expired');
});

test('reports generic message when key is rejected without reason', async () => {
  const control: MockHttpControl = {
    verifyResponse: 'accepted',
    userId: TEST_USER_ID,
    verifyCalls: 0,
    registerResponse: 'registered',
    registerCalls: 0,
    registerLastBody: null,
  };
  const baseDeps: Parameters<typeof runSetup>[0] = {
    ...deps(control),
    httpClientFactory: () =>
      ({
        verifyKey: async () => ({ success: false, message: '', userId: null, keyName: null }),
      }) as unknown as HttpClient,
  };
  const output = captureOutput();
  const result = await runSetup({ ...baseDeps, output }, { apiKey: VALID_KEY });
  expect(result.exitCode).toBe(3);
  const errorLine = output.lines.find((l) => l.level === 'error');
  expect(errorLine?.msg).toBe('ingestion key not accepted');
});

test('returns authError when verify-key omits userId on success', async () => {
  const baseDeps: Parameters<typeof runSetup>[0] = {
    ...deps(newControl()),
    httpClientFactory: () =>
      ({
        verifyKey: async () => ({
          success: true,
          message: 'ok',
          userId: null,
          keyName: 'my-key',
        }),
      }) as unknown as HttpClient,
  };
  const output = captureOutput();
  const result = await runSetup({ ...baseDeps, output }, { apiKey: VALID_KEY });
  expect(result.exitCode).toBe(3);
  const errorLine = output.lines.find((l) => l.level === 'error');
  expect(errorLine?.msg).toContain('user id');
});

test('replaces api key when re-entry matches (interactive)', async () => {
  await writeExistingConfig();
  const control = newControl();
  const d = { ...deps(control), prompts: scriptedPrompts({ apiKeys: [NEW_KEY, NEW_KEY] }) };
  const result = await runSetup(d, { force: true });
  expect(result.exitCode).toBe(0);
  expect(control.verifyCalls).toBe(1);
  const config = await loadConfigFromFile(configPath);
  expect(config.account.apiKey).toBe(NEW_KEY);
});

test('aborts when re-entry does not match (existing config preserved)', async () => {
  await writeExistingConfig();
  const control = newControl();
  const d = { ...deps(control), prompts: scriptedPrompts({ apiKeys: [NEW_KEY, OTHER_KEY] }) };
  const result = await runSetup(d, { force: true });
  expect(result.exitCode).toBe(5);
  expect(control.verifyCalls).toBe(0);
  const config = await loadConfigFromFile(configPath);
  expect(config.account.apiKey).toBe(VALID_KEY);
});

test('without --api-key or --force, existing config triggers a guided exit (alreadyInstalled)', async () => {
  await writeExistingConfig();
  const control = newControl();
  const out = captureOutput();
  const d = { ...deps(control), output: out };
  const result = await runSetup(d, {});
  expect(result.exitCode).toBe(5);
  expect(control.verifyCalls).toBe(0);
  expect(out.lines.some((l) => l.msg.includes('already configured'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('--force'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('uninstall --reset'))).toBe(true);
});

test('guided exit falls back to a generic message when the existing config fails to parse', async () => {
  await Bun.write(configPath, 'not = [valid] toml }}}');
  const control = newControl();
  const out = captureOutput();
  const d = { ...deps(control), output: out };
  const result = await runSetup(d, {});
  expect(result.exitCode).toBe(5);
  expect(out.lines.some((l) => l.msg.includes('already configured'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('host_id'))).toBe(false);
});

test('preserves installedAt and installSource on replace; rederives host_id from same user', async () => {
  const PRESERVED_INSTALLED_AT = '2025-01-15T08:00:00.000Z';
  await writeExistingConfig({
    installedAt: PRESERVED_INSTALLED_AT,
    installSource: 'brew',
  });
  const control = newControl();
  const d = { ...deps(control), prompts: scriptedPrompts({ apiKeys: [NEW_KEY, NEW_KEY] }) };
  const result = await runSetup(d, { force: true });
  expect(result.exitCode).toBe(0);
  const config = await loadConfigFromFile(configPath);
  expect(config.account.apiKey).toBe(NEW_KEY);
  expect(config.account.userId).toBe(TEST_USER_ID);
  expect(config.account.hostId).toBe(EXPECTED_HOST_ID);
  expect(config.account.installedAt).toBe(PRESERVED_INSTALLED_AT);
  expect(config.account.installSource).toBe('brew');
});

test('on replace, rederives host_id from new user_id', async () => {
  await writeExistingConfig({ userId: TEST_USER_ID, hostId: EXPECTED_HOST_ID });
  const control = newControl({ userId: TEST_USER_ID_OTHER });
  const result = await runSetup(deps(control), { apiKey: NEW_KEY });
  expect(result.exitCode).toBe(0);
  const config = await loadConfigFromFile(configPath);
  expect(config.account.userId).toBe(TEST_USER_ID_OTHER);
  expect(config.account.hostId).toBe(EXPECTED_HOST_ID_OTHER);
  expect(config.account.hostId).not.toBe(EXPECTED_HOST_ID);
});

test('scripted mode (--api-key) bypasses re-entry on existing config', async () => {
  await writeExistingConfig();
  const control = newControl();
  const result = await runSetup(deps(control), { apiKey: NEW_KEY });
  expect(result.exitCode).toBe(0);
  expect(control.verifyCalls).toBe(1);
  const config = await loadConfigFromFile(configPath);
  expect(config.account.apiKey).toBe(NEW_KEY);
  expect(config.account.hostId).toBe(EXPECTED_HOST_ID);
});

test.skipIf(process.platform === 'win32')(
  'writes config.toml with mode 0600 (owner-only) on POSIX',
  async () => {
    const control = newControl();
    const result = await runSetup(deps(control), { apiKey: VALID_KEY });
    expect(result.exitCode).toBe(0);
    const stats = await stat(configPath);
    expect(stats.mode & 0o777).toBe(0o600);
  },
);

test('returns error when readMachineUuid throws', async () => {
  const control = newControl();
  const d = {
    ...deps(control),
    readMachineUuid: async () => {
      throw new Error('cannot read /etc/machine-id');
    },
  };
  const out = captureOutput();
  d.output = out;
  const result = await runSetup(d, { apiKey: VALID_KEY });
  expect(result.exitCode).toBe(1);
  expect(
    out.lines.some((l) => l.level === 'error' && l.msg.includes('failed to read machine UUID')),
  ).toBe(true);
});

test('on replace, reports rederivation when host_id changes despite stable user_id', async () => {
  await writeExistingConfig({ userId: TEST_USER_ID, hostId: 'stale-host-id-from-old-machine' });
  const control = newControl({ userId: TEST_USER_ID });
  const out = captureOutput();
  const d = { ...deps(control), output: out };
  const result = await runSetup(d, { apiKey: NEW_KEY });
  expect(result.exitCode).toBe(0);
  expect(
    out.lines.some(
      (l) => l.level === 'info' && l.msg.includes('host_id rederived from machine UUID'),
    ),
  ).toBe(true);
  const config = await loadConfigFromFile(configPath);
  expect(config.account.hostId).toBe(EXPECTED_HOST_ID);
});

test('successful setup clears a pre-existing AUTH_FAILED sentinel', async () => {
  const control = newControl();
  const d = deps(control);

  await Bun.write(d.authFailedSentinelPath, '{"reason":"prior halt","detected_at":"x"}');
  expect(await Bun.file(d.authFailedSentinelPath).exists()).toBe(true);
  const result = await runSetup(d, { apiKey: VALID_KEY });
  expect(result.exitCode).toBe(0);
  expect(await Bun.file(d.authFailedSentinelPath).exists()).toBe(false);
});

test('failed setup (auth rejected) does not clear AUTH_FAILED sentinel', async () => {
  const control = newControl({ verifyResponse: 'rejected' });
  const d = deps(control);
  await Bun.write(d.authFailedSentinelPath, '{"reason":"prior halt","detected_at":"x"}');
  const result = await runSetup(d, { apiKey: VALID_KEY });
  expect(result.exitCode).toBe(3);
  expect(await Bun.file(d.authFailedSentinelPath).exists()).toBe(true);
});

test('register-host-id call is made with the derived host_id and reports newly bound', async () => {
  const control = newControl();
  const out = captureOutput();
  const d = { ...deps(control), output: out };
  const result = await runSetup(d, { apiKey: VALID_KEY });
  expect(result.exitCode).toBe(0);
  expect(control.registerCalls).toBe(1);
  expect(control.registerLastBody?.host_id).toBe(EXPECTED_HOST_ID);
  expect(out.lines.some((l) => l.level === 'info' && /host_id bound on backend/.test(l.msg))).toBe(
    true,
  );
});

test('register-host-id idempotent path reports already bound', async () => {
  const control = newControl({ registerResponse: 'idempotent' });
  const out = captureOutput();
  const d = { ...deps(control), output: out };
  const result = await runSetup(d, { apiKey: VALID_KEY });
  expect(result.exitCode).toBe(0);
  expect(control.registerCalls).toBe(1);
  expect(out.lines.some((l) => l.level === 'info' && /host_id already bound/.test(l.msg))).toBe(
    true,
  );
});

test('register-host-id 403 returns authError exit and surfaces a clear message', async () => {
  const control = newControl({ registerResponse: 'forbidden' });
  const out = captureOutput();
  const d = { ...deps(control), output: out };
  const result = await runSetup(d, { apiKey: VALID_KEY });
  expect(result.exitCode).toBe(3);
  expect(
    out.lines.some((l) => l.level === 'error' && /already bound to another machine/.test(l.msg)),
  ).toBe(true);
});

test('register-host-id 503 returns generic error', async () => {
  const control = newControl({ registerResponse: 'service-unavailable' });
  const out = captureOutput();
  const d = { ...deps(control), output: out };
  const result = await runSetup(d, { apiKey: VALID_KEY });
  expect(result.exitCode).toBe(1);
  expect(
    out.lines.some((l) => l.level === 'error' && /host_id registration failed/.test(l.msg)),
  ).toBe(true);
});

test('register-host-id network error returns generic error', async () => {
  const control = newControl({ registerResponse: 'network-error' });
  const out = captureOutput();
  const d = { ...deps(control), output: out };
  const result = await runSetup(d, { apiKey: VALID_KEY });
  expect(result.exitCode).toBe(1);
  expect(
    out.lines.some((l) => l.level === 'error' && /host_id registration failed/.test(l.msg)),
  ).toBe(true);
});

import type { ServiceManager } from 'cli/service-manager.ts';

interface FakeServiceManager extends ServiceManager {
  calls: { ensureRegistered: number; start: number };
}

function fakeServiceManager(opts: { failStart?: boolean } = {}): FakeServiceManager {
  const calls = { ensureRegistered: 0, start: 0 };
  return {
    calls,
    ensureRegistered: async () => {
      calls.ensureRegistered++;
    },
    start: async () => {
      calls.start++;
      if (opts.failStart === true) throw new Error('launchd offline');
    },
    stop: async () => {},
    restart: async () => {},
    unregister: async () => {},
    isRegistered: async () => true,
    isRunning: async () => true,
    runtimeInfo: async () => ({ pid: null, startedAt: null }),
  };
}

test('auto-starts the daemon by default after successful setup', async () => {
  const control = newControl();
  const sm = fakeServiceManager();
  const out = captureOutput();
  const d = {
    ...deps(control),
    output: out,
    serviceManager: sm,
    sessionStoppedSentinelPath: join(dir, 'SESSION_STOPPED'),
  };
  const result = await runSetup(d, { apiKey: VALID_KEY });
  expect(result.exitCode).toBe(0);
  expect(sm.calls.ensureRegistered).toBe(1);
  expect(sm.calls.start).toBe(1);
  expect(out.lines.some((l) => l.msg.includes('daemon started'))).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('proxai-gateway tail'))).toBe(true);
});

test('skips auto-start when --no-start is passed', async () => {
  const control = newControl();
  const sm = fakeServiceManager();
  const out = captureOutput();
  const d = {
    ...deps(control),
    output: out,
    serviceManager: sm,
  };
  const result = await runSetup(d, { apiKey: VALID_KEY, noStart: true });
  expect(result.exitCode).toBe(0);
  expect(sm.calls.start).toBe(0);
  expect(out.lines.some((l) => l.msg.includes('when you are ready'))).toBe(true);
});

test('warns but exits 0 when service manager start throws', async () => {
  const control = newControl();
  const sm = fakeServiceManager({ failStart: true });
  const out = captureOutput();
  const d = {
    ...deps(control),
    output: out,
    serviceManager: sm,
  };
  const result = await runSetup(d, { apiKey: VALID_KEY });
  expect(result.exitCode).toBe(0);
  expect(
    out.lines.some((l) => l.level === 'warn' && l.msg.includes('daemon auto-start failed')),
  ).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('manually'))).toBe(true);
});

test('falls through with manual-start hint when no service manager is supplied', async () => {
  const control = newControl();
  const out = captureOutput();
  const d = { ...deps(control), output: out };
  const result = await runSetup(d, { apiKey: VALID_KEY });
  expect(result.exitCode).toBe(0);
  expect(out.lines.some((l) => l.msg.includes('Service manager unavailable'))).toBe(true);
});

test('clears session-stopped sentinel before starting (when sentinel path supplied)', async () => {
  const control = newControl();
  const sm = fakeServiceManager();
  const out = captureOutput();
  const sentinelPath = join(dir, 'SESSION_STOPPED');
  await Bun.write(sentinelPath, JSON.stringify({ boot_id: 'b', set_at: '2026-05-08T00:00:00Z' }));
  const d = {
    ...deps(control),
    output: out,
    serviceManager: sm,
    sessionStoppedSentinelPath: sentinelPath,
  };
  await runSetup(d, { apiKey: VALID_KEY });
  expect(await Bun.file(sentinelPath).exists()).toBe(false);
});
