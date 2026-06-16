import { afterEach, beforeEach, expect, test } from 'bun:test';
import { rmRecursive, sentinelHandle } from 'core/io/fs';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSetup, runSetupNew, runSetupReset } from 'cli/commands/setup';
import { captureOutput } from 'cli/output.ts';
import { scriptedPrompts } from 'cli/prompts.ts';
import { deriveHostId } from 'core/system';
import { getBatch, insertBatch, markBatchFailed, openBufferDb } from 'services/buffer';
import { newBatch } from 'services/buffer/tests/fixtures.ts';
import { HttpClient } from 'services/http';
import {
  loadConfigFromFile,
  writeConfigToFile,
  nestIngestUrl,
  nestVerifyKeyUrl,
  DEFAULT_BUFFER_SOFT_PAUSE_BYTES,
  DEFAULT_BUFFER_SOFT_RESUME_BYTES,
  DEFAULT_FAILED_RETENTION_DAYS,
  DEFAULT_POLL_INTERVAL_SEC,
  DEFAULT_RECEIPT_RETENTION_DAYS,
  DEFAULT_STALE_PAUSE_DAYS,
  DEFAULT_STALE_WARN_DAYS,
  DEFAULT_UPLOAD_BACKOFF_ON_429_MULTIPLIER,
  DEFAULT_UPLOAD_MAX_BATCHES_PER_SEC,
  DEFAULT_UPLOAD_MAX_BYTES_PER_MINUTE,
} from 'services/config';
import { buildProfileContext } from 'core/io/fs/profile.ts';
import type { GatewayConfig } from 'services/config';
import type { ServiceManager } from 'cli/service-manager';
import type { WatchdogManager } from 'cli/watchdog-manager/types.ts';

const prodBaseUrl = buildProfileContext('prod').defaultNestBaseUrl;

const TEST_MACHINE_UUID = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
const SETUP_BOOT_ID = 'test-boot-id-setup';
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
  process.env['PROXAI_TEST_PROFILE_ROOT'] = dir;
});

afterEach(async () => {
  delete process.env['PROXAI_TEST_PROFILE_ROOT'];
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
      fetch: async (input: string | URL | Request, init?: RequestInit) => {
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
      },
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
    prompts: scriptedPrompts({ replace: true }),
    configPath,
    bufferDbPath,
    logDir,
    defaultNestBaseUrl: 'https://api.example.com',
    authFailedSentinelPath: join(dir, 'AUTH_FAILED'),
    consentSentinelPath: join(dir, 'CONSENT_ACCEPTED'),
    serviceUnitPath: join(dir, 'service.unit'),
    programPath: '/usr/local/bin/proxai-gateway',
    configExists: () => Bun.file(configPath).exists(),
    httpClientFactory: mockFactory(control),
    readMachineUuid: async () => TEST_MACHINE_UUID,
    readBootId: () => Promise.resolve(SETUP_BOOT_ID),
    readLastSuccessAt: async () => null,
    now: () => '2026-04-29T10:42:00.123Z',
    platform: 'linux',
  };
}

interface FakeServiceManager extends ServiceManager {
  calls: { ensureRegistered: number; start: number; stop: number; unregister: number };
}

function fakeServiceManager(opts: { failStart?: boolean } = {}): FakeServiceManager {
  const calls = { ensureRegistered: 0, start: 0, stop: 0, unregister: 0 };
  return {
    calls,
    ensureRegistered: async () => {
      calls.ensureRegistered++;
    },
    start: async () => {
      calls.start++;
      if (opts.failStart === true) throw new Error('launchd offline');
    },
    stop: async () => {
      calls.stop++;
    },
    restart: async () => {},
    unregister: async () => {
      calls.unregister++;
    },
    isRegistered: async () => true,
    isRunning: async () => true,
    runtimeInfo: async () => ({ pid: null, startedAt: null }),
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
      ingestUrl: nestIngestUrl(prodBaseUrl),
      verifyKeyUrl: nestVerifyKeyUrl(prodBaseUrl),
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

test('writes CONSENT_ACCEPTED sentinel on first-time setup with a timestamp', async () => {
  const control = newControl();
  const sentinelPath = join(dir, 'CONSENT_ACCEPTED');
  expect(await Bun.file(sentinelPath).exists()).toBe(false);
  const result = await runSetup(deps(control), { apiKey: VALID_KEY });
  expect(result.exitCode).toBe(0);
  expect(await Bun.file(sentinelPath).exists()).toBe(true);
  const body = await Bun.file(sentinelPath).text();
  expect(body).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('does not write CONSENT_ACCEPTED when consentSentinelPath is not provided', async () => {
  const control = newControl();
  const base = deps(control);
  const { consentSentinelPath: _omit, ...rest } = base;
  void _omit;
  const result = await runSetup(rest, { apiKey: VALID_KEY });
  expect(result.exitCode).toBe(0);
  expect(await Bun.file(join(dir, 'CONSENT_ACCEPTED')).exists()).toBe(false);
});

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

test('returns validationError when gateway key is empty', async () => {
  const control = newControl();
  const result = await runSetup(deps(control), { apiKey: '   ' });
  expect(result.exitCode).toBe(2);
  expect(control.verifyCalls).toBe(0);
});

test('returns validationError when gateway key has wrong format', async () => {
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
  const result = await runSetup(deps(control), { apiKey: VALID_KEY, installSource: 'brew' });
  expect(result.exitCode).toBe(0);
  const config = await loadConfigFromFile(configPath);
  expect(config.account.installSource).toBe('brew');
});

test('formatError falls back to String(err) when verify-key throws a non-Error value', async () => {
  const control = newControl();
  const baseDeps = deps(control);
  const output = captureOutput();
  const partialClient: unknown = {
    verifyKey: async () => {
      throw 'plain-string-failure';
    },
  };
  const httpClient = partialClient as HttpClient;
  const httpClientFactory: (apiKey: string, hostId: string) => HttpClient = () => httpClient;
  const result = await runSetup({ ...baseDeps, output, httpClientFactory }, { apiKey: VALID_KEY });
  expect(result.exitCode).toBe(1);
  const errorLine = output.lines.find((l) => l.level === 'error');
  expect(errorLine?.msg).toContain('verify-key failed');
  expect(errorLine?.msg).toContain('plain-string-failure');
});

test('reports server-provided message when key is rejected with reason', async () => {
  const control = newControl({ verifyResponse: 'rejected' });
  const output = captureOutput();
  const result = await runSetup({ ...deps(control), output }, { apiKey: VALID_KEY });
  expect(result.exitCode).toBe(3);
  const errorLine = output.lines.find((l) => l.level === 'error');
  expect(errorLine?.msg).toContain('key expired');
});

test('reports generic message when key is rejected without reason', async () => {
  const baseDeps: Parameters<typeof runSetup>[0] = {
    ...deps(newControl()),
    httpClientFactory: () => {
      const partial: unknown = {
        verifyKey: async () => ({ success: false, message: '', userId: null, keyName: null }),
      };
      return partial as HttpClient;
    },
  };
  const output = captureOutput();
  const result = await runSetup({ ...baseDeps, output }, { apiKey: VALID_KEY });
  expect(result.exitCode).toBe(3);
  const errorLine = output.lines.find((l) => l.level === 'error');
  expect(errorLine?.msg).toBe('gateway key not accepted');
});

test('returns authError when verify-key omits userId on success', async () => {
  const baseDeps: Parameters<typeof runSetup>[0] = {
    ...deps(newControl()),
    httpClientFactory: () => {
      const partial: unknown = {
        verifyKey: async () => ({ success: true, message: 'ok', userId: null, keyName: 'my-key' }),
      };
      return partial as HttpClient;
    },
  };
  const output = captureOutput();
  const result = await runSetup({ ...baseDeps, output }, { apiKey: VALID_KEY });
  expect(result.exitCode).toBe(3);
  const errorLine = output.lines.find((l) => l.level === 'error');
  expect(errorLine?.msg).toContain('user id');
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
  const out = captureOutput();
  const d = {
    ...deps(control),
    output: out,
    readMachineUuid: async () => {
      throw new Error('cannot read /etc/machine-id');
    },
  };
  const result = await runSetup(d, { apiKey: VALID_KEY });
  expect(result.exitCode).toBe(1);
  expect(
    out.lines.some((l) => l.level === 'error' && l.msg.includes('failed to read machine UUID')),
  ).toBe(true);
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
  const result = await runSetup({ ...deps(control), output: out }, { apiKey: VALID_KEY });
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
  const result = await runSetup({ ...deps(control), output: out }, { apiKey: VALID_KEY });
  expect(result.exitCode).toBe(0);
  expect(control.registerCalls).toBe(1);
  expect(out.lines.some((l) => l.level === 'info' && /host_id already bound/.test(l.msg))).toBe(
    true,
  );
});

test('register-host-id 403 returns authError exit and surfaces a clear message', async () => {
  const control = newControl({ registerResponse: 'forbidden' });
  const out = captureOutput();
  const result = await runSetup({ ...deps(control), output: out }, { apiKey: VALID_KEY });
  expect(result.exitCode).toBe(3);
  expect(
    out.lines.some((l) => l.level === 'error' && /already bound to another machine/.test(l.msg)),
  ).toBe(true);
});

test('register-host-id 503 returns generic error', async () => {
  const control = newControl({ registerResponse: 'service-unavailable' });
  const out = captureOutput();
  const result = await runSetup({ ...deps(control), output: out }, { apiKey: VALID_KEY });
  expect(result.exitCode).toBe(1);
  expect(
    out.lines.some((l) => l.level === 'error' && /host_id registration failed/.test(l.msg)),
  ).toBe(true);
});

test('register-host-id network error returns generic error', async () => {
  const control = newControl({ registerResponse: 'network-error' });
  const out = captureOutput();
  const result = await runSetup({ ...deps(control), output: out }, { apiKey: VALID_KEY });
  expect(result.exitCode).toBe(1);
  expect(
    out.lines.some((l) => l.level === 'error' && /host_id registration failed/.test(l.msg)),
  ).toBe(true);
});

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
  expect(out.lines.some((l) => l.msg.includes('proxai-gateway logs'))).toBe(true);
});

test('skips auto-start when --no-start is passed', async () => {
  const control = newControl();
  const sm = fakeServiceManager();
  const out = captureOutput();
  const d = { ...deps(control), output: out, serviceManager: sm };
  const result = await runSetup(d, { apiKey: VALID_KEY, noStart: true });
  expect(result.exitCode).toBe(0);
  expect(sm.calls.start).toBe(0);
  expect(out.lines.some((l) => l.msg.includes('when you are ready'))).toBe(true);
});

test('warns but exits 0 when service manager start throws', async () => {
  const control = newControl();
  const sm = fakeServiceManager({ failStart: true });
  const out = captureOutput();
  const d = { ...deps(control), output: out, serviceManager: sm };
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
  await runSetup({ ...deps(control), output: out }, { apiKey: VALID_KEY });
  expect(out.lines.some((l) => l.msg.includes('Service manager unavailable'))).toBe(true);
});

test('clears session-stopped sentinel before starting (when sentinel path supplied)', async () => {
  const control = newControl();
  const sm = fakeServiceManager();
  const sentinelPath = join(dir, 'SESSION_STOPPED');
  await Bun.write(sentinelPath, JSON.stringify({ boot_id: 'b', set_at: '2026-05-08T00:00:00Z' }));
  const d = {
    ...deps(control),
    serviceManager: sm,
    sessionStoppedSentinelPath: sentinelPath,
  };
  await runSetup(d, { apiKey: VALID_KEY });
  expect(await Bun.file(sentinelPath).exists()).toBe(false);
});

test('maybeWriteConsentSentinel handles write error gracefully', async () => {
  const control = newControl();
  const d = {
    ...deps(control),
    consentSentinelPath: join(dir, 'non-existent-subfolder', 'CONSENT_ACCEPTED'),
  };
  const result = await runSetup(d, { apiKey: VALID_KEY });
  expect(result.exitCode).toBe(0);
});

test('runConfigure clears failed batches and the buffer_full sentinel', async () => {
  const d = deps(newControl());
  d.bufferFullSentinelPath = join(d.logDir, 'BUFFER_FULL');
  const sentinel = sentinelHandle(d.bufferFullSentinelPath);
  await sentinel.write('full');

  const seed = openBufferDb(d.bufferDbPath);
  const failed = newBatch({ body: new Uint8Array(50) });
  insertBatch(seed, failed);
  markBatchFailed(seed, failed.captureId, 'old error');
  seed.close();

  const result = await runSetupNew(d, { apiKey: VALID_KEY });
  expect(result.exitCode).toBe(0);

  const verify = openBufferDb(d.bufferDbPath);
  expect(getBatch(verify, failed.captureId)).toBeNull();
  verify.close();
  expect(await sentinel.exists()).toBe(false);
});

test('setup new replaces the key when given a new gateway key', async () => {
  await writeExistingConfig();
  const control = newControl({ userId: TEST_USER_ID_OTHER });
  const result = await runSetupNew(deps(control), { apiKey: NEW_KEY });
  expect(result.exitCode).toBe(0);
  expect(control.verifyCalls).toBe(1);
  const config = await loadConfigFromFile(configPath);
  expect(config.account.apiKey).toBe(NEW_KEY);
  expect(config.account.userId).toBe(TEST_USER_ID_OTHER);
  expect(config.account.hostId).toBe(EXPECTED_HOST_ID_OTHER);
  expect(config.account.hostId).not.toBe(EXPECTED_HOST_ID);
});

test('setup new does not overwrite CONSENT_ACCEPTED on replace', async () => {
  await writeExistingConfig();
  const sentinelPath = join(dir, 'CONSENT_ACCEPTED');
  await Bun.write(sentinelPath, '2025-01-01T00:00:00.000Z');
  const control = newControl();
  const result = await runSetupNew(deps(control), { apiKey: NEW_KEY });
  expect(result.exitCode).toBe(0);
  expect(await Bun.file(sentinelPath).text()).toBe('2025-01-01T00:00:00.000Z');
});

test('setup new preserves installedAt and installSource on replace', async () => {
  const PRESERVED_INSTALLED_AT = '2025-01-15T08:00:00.000Z';
  await writeExistingConfig({ installedAt: PRESERVED_INSTALLED_AT, installSource: 'brew' });
  const control = newControl();
  const result = await runSetupNew(deps(control), { apiKey: NEW_KEY });
  expect(result.exitCode).toBe(0);
  const config = await loadConfigFromFile(configPath);
  expect(config.account.apiKey).toBe(NEW_KEY);
  expect(config.account.installedAt).toBe(PRESERVED_INSTALLED_AT);
  expect(config.account.installSource).toBe('brew');
});

test('setup new replaces the key when interactive re-entry matches', async () => {
  await writeExistingConfig();
  const control = newControl();
  const d = { ...deps(control), prompts: scriptedPrompts({ apiKeys: [NEW_KEY, NEW_KEY] }) };
  const result = await runSetupNew(d, {});
  expect(result.exitCode).toBe(0);
  expect(control.verifyCalls).toBe(1);
  const config = await loadConfigFromFile(configPath);
  expect(config.account.apiKey).toBe(NEW_KEY);
});

test('setup new aborts when interactive re-entry does not match', async () => {
  await writeExistingConfig();
  const control = newControl();
  const d = { ...deps(control), prompts: scriptedPrompts({ apiKeys: [NEW_KEY, OTHER_KEY] }) };
  const result = await runSetupNew(d, {});
  expect(result.exitCode).toBe(5);
  expect(control.verifyCalls).toBe(0);
  const config = await loadConfigFromFile(configPath);
  expect(config.account.apiKey).toBe(VALID_KEY);
});

test('setup new reports rederivation when host_id changes despite stable user_id', async () => {
  await writeExistingConfig({ userId: TEST_USER_ID, hostId: 'stale-host-id-from-old-machine' });
  const control = newControl({ userId: TEST_USER_ID });
  const out = captureOutput();
  const result = await runSetupNew({ ...deps(control), output: out }, { apiKey: NEW_KEY });
  expect(result.exitCode).toBe(0);
  expect(
    out.lines.some(
      (l) => l.level === 'info' && l.msg.includes('host_id rederived from machine UUID'),
    ),
  ).toBe(true);
  const config = await loadConfigFromFile(configPath);
  expect(config.account.hostId).toBe(EXPECTED_HOST_ID);
});

test('setup new on a fresh machine configures normally', async () => {
  const control = newControl();
  const result = await runSetupNew(deps(control), { apiKey: VALID_KEY });
  expect(result.exitCode).toBe(0);
  const config = await loadConfigFromFile(configPath);
  expect(config.account.apiKey).toBe(VALID_KEY);
});

test('setup on a configured machine shows the status view with key + last upload', async () => {
  await writeExistingConfig();
  const out = captureOutput();
  const d = {
    ...deps(newControl()),
    output: out,
    readLastSuccessAt: async () => '2026-04-29T10:38:00.000Z',
  };
  const result = await runSetup(d, {});
  expect(result.exitCode).toBe(5);
  const joined = out.lines.map((l) => l.msg).join('\n');
  expect(joined).toContain('configured');
  expect(joined).toContain('Gateway key');
  expect(joined).toContain('abc1…t456');
  expect(joined).toContain('Last upload');
  expect(joined).toContain('29 Apr');
  expect(joined).toContain('min ago');
  expect(joined).toContain('proxai-gateway setup new');
  expect(joined).toContain('proxai-gateway setup reset');
});

test('status view shows a no-upload hint when there is no successful upload', async () => {
  await writeExistingConfig();
  const out = captureOutput();
  const d = { ...deps(newControl()), output: out, readLastSuccessAt: async () => null };
  await runSetup(d, {});
  expect(out.lines.some((l) => l.msg.includes('no successful upload yet'))).toBe(true);
});

test('status view tolerates a missing readLastSuccessAt dep', async () => {
  await writeExistingConfig();
  const out = captureOutput();
  const base = deps(newControl());
  const { readLastSuccessAt: _omit, ...rest } = base;
  void _omit;
  const result = await runSetup({ ...rest, output: out }, {});
  expect(result.exitCode).toBe(5);
  expect(out.lines.some((l) => l.msg.includes('no successful upload yet'))).toBe(true);
});

test('status view reports an unreadable configuration', async () => {
  await Bun.write(configPath, 'not = [valid] toml }}}');
  const out = captureOutput();
  const result = await runSetup({ ...deps(newControl()), output: out }, {});
  expect(result.exitCode).toBe(5);
  expect(out.lines.some((l) => l.msg.includes('could not be read'))).toBe(true);
});

test('setup with a key on a configured machine keeps the key and notes it was unchanged', async () => {
  await writeExistingConfig();
  const control = newControl();
  const out = captureOutput();
  const d = {
    ...deps(control),
    output: out,
    readLastSuccessAt: async () => '2026-04-29T10:38:00.000Z',
  };
  const result = await runSetup(d, { apiKey: NEW_KEY });
  expect(result.exitCode).toBe(5);
  expect(control.verifyCalls).toBe(0);
  const joined = out.lines.map((l) => l.msg).join('\n');
  expect(joined).toContain('already configured');
  expect(joined).toContain('was not changed');
  expect(joined).toContain('Gateway key');
  expect(joined).toContain('abc1…t456');
  expect(joined).toContain('proxai-gateway setup new');
  const config = await loadConfigFromFile(configPath);
  expect(config.account.apiKey).not.toBe(NEW_KEY);
});

test('setup reset on an unconfigured machine reports nothing to reset', async () => {
  const out = captureOutput();
  const result = await runSetupReset({ ...deps(newControl()), output: out }, {});
  expect(result.exitCode).toBe(0);
  expect(out.lines.some((l) => l.msg.includes('nothing to reset'))).toBe(true);
});

test('setup reset --yes stops, unregisters, and removes the key + config', async () => {
  await writeExistingConfig();
  const sm = fakeServiceManager();
  const out = captureOutput();
  const authPath = join(dir, 'AUTH_FAILED');
  const sessionPath = join(dir, 'SESSION_STOPPED');
  await Bun.write(authPath, '{"reason":"x","detected_at":"y"}');
  await Bun.write(sessionPath, '{"boot_id":"b"}');
  await Bun.write(join(dir, 'service.unit'), 'unit');
  const d = {
    ...deps(newControl()),
    output: out,
    serviceManager: sm,
    sessionStoppedSentinelPath: sessionPath,
  };
  const result = await runSetupReset(d, { yes: true });
  expect(result.exitCode).toBe(0);
  expect(sm.calls.stop).toBe(1);
  expect(sm.calls.unregister).toBe(1);
  expect(await Bun.file(configPath).exists()).toBe(false);
  expect(await Bun.file(join(dir, 'service.unit')).exists()).toBe(false);
  expect(await Bun.file(authPath).exists()).toBe(false);
  expect(await Bun.file(sessionPath).exists()).toBe(false);
  expect(out.lines.some((l) => l.msg.includes('waiting for configuration'))).toBe(true);
});

test('setup reset keeps the buffer database', async () => {
  await writeExistingConfig();
  await Bun.write(bufferDbPath, 'buffer-bytes');
  const result = await runSetupReset(
    { ...deps(newControl()), serviceManager: fakeServiceManager() },
    { yes: true },
  );
  expect(result.exitCode).toBe(0);
  expect(await Bun.file(bufferDbPath).exists()).toBe(true);
});

test('setup reset proceeds when the confirmation phrase matches', async () => {
  await writeExistingConfig();
  const sm = fakeServiceManager();
  const d = {
    ...deps(newControl()),
    serviceManager: sm,
    prompts: scriptedPrompts({ phrase: 'setup reset' }),
  };
  const result = await runSetupReset(d, {});
  expect(result.exitCode).toBe(0);
  expect(await Bun.file(configPath).exists()).toBe(false);
});

test('setup reset aborts when the confirmation phrase does not match', async () => {
  await writeExistingConfig();
  const out = captureOutput();
  const d = {
    ...deps(newControl()),
    output: out,
    serviceManager: fakeServiceManager(),
    prompts: scriptedPrompts({ phrase: 'nope' }),
  };
  const result = await runSetupReset(d, {});
  expect(result.exitCode).toBe(5);
  expect(await Bun.file(configPath).exists()).toBe(true);
  expect(out.lines.some((l) => l.msg.includes('aborted'))).toBe(true);
});

test('setup reset tolerates a null service unit path and missing service manager', async () => {
  await writeExistingConfig();
  const base = deps(newControl());
  const { serviceManager: _omit, ...rest } = base;
  void _omit;
  const d = { ...rest, serviceUnitPath: null as string | null };
  const result = await runSetupReset(d, { yes: true });
  expect(result.exitCode).toBe(0);
  expect(await Bun.file(configPath).exists()).toBe(false);
});

test('writeServiceUnitIfNeeded and autoStartDaemon watchdog branches', async () => {
  const { writeServiceUnitIfNeeded, autoStartDaemon } =
    await import('cli/commands/setup/install-and-start.ts');
  const out = captureOutput();
  let watchdogInstalled = false;
  const watchdogManager: WatchdogManager = {
    install: async () => {
      watchdogInstalled = true;
    },
    uninstall: async () => {},
    isInstalled: async () => false,
  };
  const d = {
    ...deps(newControl()),
    output: out,
    platform: 'darwin' as const,
    programPath: '/bin/gateway',
    serviceUnitPath: join(dir, 'unit.plist'),
    watchdogUnitPaths: { plistPath: join(dir, 'watchdog.plist') },
    serviceManager: fakeServiceManager(),
    watchdogManager,
    profileCtx: buildProfileContext('prod'),
  };

  await writeServiceUnitIfNeeded(d);
  expect(await Bun.file(join(dir, 'watchdog.plist')).exists()).toBe(true);

  const result = await autoStartDaemon(d, { yes: true });
  expect(result.exitCode).toBe(0);
  expect(watchdogInstalled).toBe(true);
});

test('autoStartDaemon formatError falls back to String(err) on non-Error values', async () => {
  const control = newControl();
  const sm = fakeServiceManager();
  sm.start = async () => {
    throw 'launchd-offline-string';
  };
  const out = captureOutput();
  const d = { ...deps(control), output: out, serviceManager: sm };
  const result = await runSetup(d, { apiKey: VALID_KEY });
  expect(result.exitCode).toBe(0);
  expect(
    out.lines.some(
      (l) =>
        l.level === 'warn' && l.msg.includes('daemon auto-start failed: launchd-offline-string'),
    ),
  ).toBe(true);
});
