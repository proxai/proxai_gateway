/**
 * E2E test helpers: temp directories, fixture planters, and programmatic
 * setup / single-cycle drivers. The helpers compose the production code
 * paths (runSetup + runPollCycle) without launching the daemon's poll loop,
 * so each scenario advances exactly one cycle and assertions stay
 * deterministic.
 */
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { runSetup } from 'cli/commands/setup.ts';
import type { SetupCommandDeps } from 'cli/commands/setup.ts';
import { silentOutput } from 'cli/output.ts';
import { scriptedPrompts } from 'cli/prompts.ts';
import { ensureDir } from 'core/io/fs';
import { openBufferDb } from 'services/buffer';
import {
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
  loadConfigFromFile,
} from 'services/config';
import type { GatewayConfig } from 'services/config';
import { HttpClient } from 'services/http';
import { buildDefaultSources, runPollCycle } from 'services/polling';
import type { PollCycleContext, PollCycleResult } from 'services/polling';

export interface TempEnv {
  root: string;
  configPath: string;
  bufferDbPath: string;
  logDir: string;
  pauseSentinelPath: string;
  authFailedSentinelPath: string;
  bufferFullSentinelPath: string;
  serviceUnitPath: string;
  // Source roots planted with fixtures.
  claudeCodeRoot: string;
  cursorRoot: string;
  codexRoot: string;
  cleanup(): Promise<void>;
}

export const TEST_GATEWAY_VERSION = '@proxai/gateway 0.1.0-e2e';

export async function mkTempProxaiDir(): Promise<TempEnv> {
  const root = await mkdtemp(join(tmpdir(), 'proxai-e2e-'));
  const configPath = join(root, 'config.toml');
  const bufferDbPath = join(root, 'buffer.db');
  const logDir = join(root, 'logs');
  const pauseSentinelPath = join(root, 'PAUSED');
  const authFailedSentinelPath = join(root, 'AUTH_FAILED');
  const bufferFullSentinelPath = join(root, 'BUFFER_FULL');
  const serviceUnitPath = join(root, 'service.unit');
  const claudeCodeRoot = join(root, 'claude-code-projects');
  const cursorRoot = join(root, 'cursor-user');
  const codexRoot = join(root, 'codex-home');
  await ensureDir(claudeCodeRoot);
  await ensureDir(cursorRoot);
  await ensureDir(codexRoot);
  return {
    root,
    configPath,
    bufferDbPath,
    logDir,
    pauseSentinelPath,
    authFailedSentinelPath,
    bufferFullSentinelPath,
    serviceUnitPath,
    claudeCodeRoot,
    cursorRoot,
    codexRoot,
    cleanup: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * Plants a Claude Code JSONL session file under
 * `<claudeCodeRoot>/<projectDir>/<file>.jsonl`. Returns the absolute path.
 */
export async function plantClaudeCodeJsonl(
  env: TempEnv,
  projectDir: string,
  fileName: string,
  content: string | Uint8Array,
): Promise<string> {
  const projectFull = join(env.claudeCodeRoot, projectDir);
  await ensureDir(projectFull);
  const filePath = join(projectFull, fileName);
  await Bun.write(filePath, content);
  return filePath;
}

export async function appendClaudeCodeJsonl(
  filePath: string,
  content: string | Uint8Array,
): Promise<void> {
  const existing = await Bun.file(filePath).bytes();
  const addition = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  const merged = new Uint8Array(existing.byteLength + addition.byteLength);
  merged.set(existing, 0);
  merged.set(addition, existing.byteLength);
  await Bun.write(filePath, merged);
}

export interface SetupResult {
  exitCode: number;
  config: GatewayConfig;
}

export interface SetupOptions {
  apiKey: string;
  nestUrl: string;
  machineUuid: string;
  installedAt?: string;
}

/**
 * Runs the production `runSetup` against the temp env using the fake-nest
 * URL for backend endpoints. Returns the loaded config so tests can inspect
 * derived host_id and other values.
 */
export async function setupGateway(env: TempEnv, opts: SetupOptions): Promise<SetupResult> {
  await ensureDir(dirname(env.configPath));
  const deps: SetupCommandDeps = {
    output: silentOutput(),
    prompts: scriptedPrompts({}),
    configPath: env.configPath,
    bufferDbPath: env.bufferDbPath,
    logDir: env.logDir,
    authFailedSentinelPath: env.authFailedSentinelPath,
    serviceUnitPath: env.serviceUnitPath,
    programPath: '/usr/local/bin/proxai-gateway',
    configExists: () => Bun.file(env.configPath).exists(),
    httpClientFactory: (apiKey, hostId) =>
      new HttpClient({
        apiKey,
        hostId,
        endpoints: {
          ingest: `${opts.nestUrl}/v1/raw_records`,
          verifyKey: `${opts.nestUrl}/ingestion/verify-key`,
          watermarks: `${opts.nestUrl}/v1/watermarks`,
          registerHostId: `${opts.nestUrl}/v1/host-ids/register`,
        },
        gatewayVersion: TEST_GATEWAY_VERSION,
      }),
    readMachineUuid: async () => opts.machineUuid,
    now: () => opts.installedAt ?? '2026-04-29T10:42:00.123Z',
    platform: 'linux',
  };
  const result = await runSetup(deps, {
    apiKey: opts.apiKey,
    skipKeyFormatCheck: true,
  });
  // Patch backend URLs to point at fake-nest. setup writes the production
  // NEST_* constants by default; rewrite to the test URLs so the daemon
  // path uses the test server too.
  if (result.exitCode === 0) {
    const cfg = await loadConfigFromFile(env.configPath);
    cfg.backend.ingestUrl = `${opts.nestUrl}/v1/raw_records`;
    cfg.backend.verifyKeyUrl = `${opts.nestUrl}/ingestion/verify-key`;
    cfg.backend.watermarksUrl = `${opts.nestUrl}/v1/watermarks`;
    cfg.backend.registerHostIdUrl = `${opts.nestUrl}/v1/host-ids/register`;
    const { writeConfigToFile } = await import('services/config');
    await writeConfigToFile(cfg, env.configPath);
    return { exitCode: result.exitCode, config: cfg };
  }
  // On failure, return a stub config (caller normally won't read it).
  return {
    exitCode: result.exitCode,
    config: undefined as unknown as GatewayConfig,
  };
}

export interface RunCycleOptions {
  env: TempEnv;
  apiKey: string;
  hostId: string;
  nestUrl: string;
  buffer: Database;
  /**
   * Optional override. When omitted, default sources are built using the
   * temp roots so the cycle exercises the real Claude Code / Cursor / Codex
   * pollers.
   */
  sources?: PollCycleContext['sources'];
  /** Override for installedAt (used for stale-binary tests). */
  installedAt?: string;
}

/**
 * Runs exactly one poll cycle (capture sources, drain buffer, prune,
 * pressure-check). Returns the cycle result for assertions.
 */
export async function runOneCycle(opts: RunCycleOptions): Promise<PollCycleResult> {
  const http = new HttpClient({
    apiKey: opts.apiKey,
    hostId: opts.hostId,
    endpoints: {
      ingest: `${opts.nestUrl}/v1/raw_records`,
      verifyKey: `${opts.nestUrl}/ingestion/verify-key`,
      watermarks: `${opts.nestUrl}/v1/watermarks`,
      registerHostId: `${opts.nestUrl}/v1/host-ids/register`,
    },
    gatewayVersion: TEST_GATEWAY_VERSION,
  });
  const sources =
    opts.sources ??
    buildDefaultSources({
      claudeCodeBaseDir: opts.env.claudeCodeRoot,
      cursorBaseDir: opts.env.cursorRoot,
      codexBaseDir: opts.env.codexRoot,
      initialScanWindowDays: 0,
    });
  const ctx: PollCycleContext = {
    buffer: opts.buffer,
    http,
    hostId: opts.hostId,
    gatewayVersion: TEST_GATEWAY_VERSION,
    sources,
    pauseSentinelPath: opts.env.pauseSentinelPath,
    authFailedSentinelPath: opts.env.authFailedSentinelPath,
    bufferFullSentinelPath: opts.env.bufferFullSentinelPath,
    installedAt: opts.installedAt ?? '2026-04-29T10:42:00.123Z',
    staleBinary: {
      warnAfterDays: DEFAULT_STALE_WARN_DAYS,
      pauseAfterDays: DEFAULT_STALE_PAUSE_DAYS,
    },
    bufferPolicy: {
      receiptRetentionDays: DEFAULT_RECEIPT_RETENTION_DAYS,
      failedRetentionDays: DEFAULT_FAILED_RETENTION_DAYS,
      softPauseBytes: DEFAULT_BUFFER_SOFT_PAUSE_BYTES,
      softResumeBytes: DEFAULT_BUFFER_SOFT_RESUME_BYTES,
    },
    capturePolicy: { initialScanWindowDays: DEFAULT_INITIAL_SCAN_WINDOW_DAYS },
  };
  return runPollCycle(ctx);
}

/**
 * Returns a fresh handle to the buffer DB at the env path. Caller closes.
 */
export function openEnvBuffer(env: TempEnv): Database {
  return openBufferDb(env.bufferDbPath);
}

/**
 * Builds a synthetic GatewayConfig based on the env's paths. Useful for
 * runDaemon-style assertions when setup is bypassed.
 */
export function makeSyntheticConfig(
  env: TempEnv,
  account: {
    apiKey: string;
    userId: string;
    hostId: string;
    nestUrl: string;
  },
): GatewayConfig {
  return {
    account: {
      apiKey: account.apiKey,
      userId: account.userId,
      hostId: account.hostId,
      installedAt: '2026-04-29T10:42:00.123Z',
      installSource: 'github_release',
    },
    backend: {
      ingestUrl: `${account.nestUrl}/v1/raw_records`,
      verifyKeyUrl: `${account.nestUrl}/ingestion/verify-key`,
      watermarksUrl: `${account.nestUrl}/v1/watermarks`,
      registerHostIdUrl: `${account.nestUrl}/v1/host-ids/register`,
    },
    capture: {
      pollIntervalSec: DEFAULT_POLL_INTERVAL_SEC,
      bufferPath: env.bufferDbPath,
      receiptRetentionDays: DEFAULT_RECEIPT_RETENTION_DAYS,
      failedRetentionDays: DEFAULT_FAILED_RETENTION_DAYS,
      bufferSoftPauseBytes: DEFAULT_BUFFER_SOFT_PAUSE_BYTES,
      bufferSoftResumeBytes: DEFAULT_BUFFER_SOFT_RESUME_BYTES,
      initialScanWindowDays: DEFAULT_INITIAL_SCAN_WINDOW_DAYS,
      uploadMaxBatchesPerSec: DEFAULT_UPLOAD_MAX_BATCHES_PER_SEC,
      uploadMaxBytesPerMinute: DEFAULT_UPLOAD_MAX_BYTES_PER_MINUTE,
      uploadBackoffOn429Multiplier: DEFAULT_UPLOAD_BACKOFF_ON_429_MULTIPLIER,
    },
    logging: { level: 'info', logDir: env.logDir },
    staleBinary: {
      warnAfterDays: DEFAULT_STALE_WARN_DAYS,
      pauseAfterDays: DEFAULT_STALE_PAUSE_DAYS,
    },
  };
}
