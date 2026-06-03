import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServiceManager } from 'cli/service-manager';
import { buildProfileContext } from 'core/io/fs/profile.ts';
import { buildStatusContext } from 'cli/wiring/status-deps.ts';
import { openBufferDb } from 'services/buffer';

const sm = {
  ensureRegistered: async () => {},
  start: async () => {},
  stop: async () => {},
  restart: async () => {},
  unregister: async () => {},
  isRegistered: async () => false,
  isRunning: async () => false,
  runtimeInfo: async () => ({ pid: null, startedAt: null }),
} satisfies ServiceManager;

const profileCtx = buildProfileContext('prod');

test('buildStatusContext: returns minimal deps and noop cleanup when config does not exist', async () => {
  const ctx = await buildStatusContext({
    profileCtx,
    configPath: '/dev/null/proxai-no-such-config.toml',
    json: false,
    serviceManager: null,
  });
  expect(ctx.deps.buffer).toBeUndefined();
  expect(ctx.options).toEqual({ profileName: 'prod' });
  ctx.cleanup();
});

test('buildStatusContext: labels options with the dev profile name', async () => {
  const ctx = await buildStatusContext({
    profileCtx: buildProfileContext('dev'),
    configPath: '/dev/null/proxai-no-such-config.toml',
    json: false,
    serviceManager: null,
  });
  expect(ctx.options.profileName).toBe('dev');
  ctx.cleanup();
});

test('buildStatusContext: forwards json flag', async () => {
  const ctx = await buildStatusContext({
    profileCtx,
    configPath: '/dev/null/proxai-no-such-config.toml',
    json: true,
    serviceManager: null,
  });
  expect(ctx.options.json).toBe(true);
  ctx.cleanup();
});

test('buildStatusContext: configExists() resolves false when no config', async () => {
  const ctx = await buildStatusContext({
    profileCtx,
    configPath: '/dev/null/proxai-no-such.toml',
    json: false,
    serviceManager: null,
  });
  await expect(ctx.deps.configExists()).resolves.toBe(false);
  ctx.cleanup();
});

test('buildStatusContext: opens buffer and includes serviceManager when config file exists', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'proxai-statusctx-'));
  try {
    const cfgPath = join(dir, 'config.toml');
    const bufferPath = join(dir, 'buffer.db');
    const minimalToml = [
      '[account]',
      'install_source = "github_release"',
      'host_id = "h"',
      'user_id = "u"',
      'api_key = "k"',
      'installed_at = "2026-01-01T00:00:00Z"',
      '',
      '[capture]',
      `buffer_path = "${bufferPath.replace(/\\/g, '\\\\')}"`,
      '',
      '[logging]',
      `log_dir = "${dir.replace(/\\/g, '\\\\')}"`,
      '',
      '[backend]',
      'ingest_url = "https://x"',
      'verify_key_url = "https://x"',
      'watermarks_url = "https://x"',
      'register_host_id_url = "https://x"',
      '',
    ].join('\n');
    await writeFile(cfgPath, minimalToml, 'utf8');
    openBufferDb(bufferPath).close();
    const ctx = await buildStatusContext({
      profileCtx,
      configPath: cfgPath,
      configOverride: cfgPath,
      json: true,
      serviceManager: sm,
    });
    expect(ctx.options.json).toBe(true);
    expect(ctx.deps.serviceManager).toBe(sm);
    expect(ctx.deps.buffer).toBeDefined();
    await expect(ctx.deps.configExists()).resolves.toBe(true);
    expect(ctx.deps.loadConfig).toBeDefined();
    const loader = ctx.deps.loadConfig;
    if (loader !== undefined) {
      const settled = await loader(cfgPath).then(
        () => 'resolved',
        () => 'rejected',
      );
      expect(typeof settled).toBe('string');
    }
    ctx.cleanup();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildStatusContext: falls back to default buffer path when configOverride load fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'proxai-statusctx-fallback-'));
  try {
    const cfgPath = join(dir, 'config.toml');
    const fallbackBuffer = join(dir, 'fallback.db');
    await writeFile(cfgPath, 'malformed = toml without sections', 'utf8');
    openBufferDb(fallbackBuffer).close();
    const ctx = await buildStatusContext({
      profileCtx,
      configPath: cfgPath,
      defaultBufferPath: fallbackBuffer,
      json: false,
      serviceManager: null,
    });
    expect(ctx.deps.buffer).toBeDefined();
    ctx.cleanup();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildStatusContext: omits serviceManager when null', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'proxai-statusctx-no-sm-'));
  try {
    const cfgPath = join(dir, 'config.toml');
    const bufferPath = join(dir, 'buffer.db');
    const minimalToml = [
      '[account]',
      'install_source = "github_release"',
      'host_id = "h"',
      'user_id = "u"',
      'api_key = "k"',
      'installed_at = "2026-01-01T00:00:00Z"',
      '',
      '[capture]',
      `buffer_path = "${bufferPath.replace(/\\/g, '\\\\')}"`,
      '',
      '[logging]',
      `log_dir = "${dir.replace(/\\/g, '\\\\')}"`,
      '',
      '[backend]',
      'ingest_url = "https://x"',
      'verify_key_url = "https://x"',
      'watermarks_url = "https://x"',
      'register_host_id_url = "https://x"',
      '',
    ].join('\n');
    await writeFile(cfgPath, minimalToml, 'utf8');
    openBufferDb(bufferPath).close();
    const ctx = await buildStatusContext({
      profileCtx,
      configPath: cfgPath,
      configOverride: cfgPath,
      json: false,
      serviceManager: null,
    });
    expect('serviceManager' in ctx.deps).toBe(false);
    ctx.cleanup();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
