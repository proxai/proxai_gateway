import { ensureDir, setMode, writeAtomic } from 'core/io/fs';
import { dirname } from 'node:path';

import { deriveHostId, readMachineUuid } from 'core/system';
import { AuthError, GatewayError, nowIsoUtc } from 'core/utils';
import { EXIT_CODE } from 'cli/cli.constants.ts';
import type { CommandResult, OutputSink } from 'cli/cli.types.ts';
import { buildLaunchdPlist } from 'cli/launchd-plist.ts';
import type { PromptSink } from 'cli/prompts.ts';
import { buildScheduledTaskXml, encodeScheduledTaskXml } from 'cli/scheduled-task-xml.ts';
import { buildSystemdUnit } from 'cli/systemd-unit.ts';
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
  NEST_INGEST_URL,
  NEST_VERIFY_KEY_URL,
  NEST_WATERMARKS_URL,
} from 'services/config';
import type { GatewayConfig, InstallSource } from 'services/config';
import { loadConfigFromFile, writeConfigToFile } from 'services/config';
import { HttpClient } from 'services/http';
import { clearAuthFailedSentinel } from 'services/polling/auth-failed-sentinel.ts';

// Three hyphen-separated alphanumeric parts. Nest's key generator
// (api-key-repository.service.ts) produces `<rand36>-<Date.now().toString(36)>-<rand36>`,
// so the middle segment is base-36 (alphanumeric), NOT digits-only.
// The minimum-length floors are sized to the smallest plausible
// generator output and reject obvious typos early.
const INGESTION_KEY_PATTERN = /^[A-Za-z0-9]{4,}-[A-Za-z0-9]{4,}-[A-Za-z0-9]{4,}$/;

export interface SetupCommandDeps {
  output: OutputSink;
  prompts: PromptSink;
  configPath: string;
  bufferDbPath: string;
  logDir: string;
  authFailedSentinelPath: string;
  serviceUnitPath: string | null;
  programPath: string;
  configExists: () => Promise<boolean>;
  httpClientFactory: (apiKey: string, hostId: string) => HttpClient;
  readMachineUuid?: () => Promise<string>;
  now?: () => string;
  platform: NodeJS.Platform;
  windowsUserId?: string;
}

export interface SetupCommandOptions {
  apiKey?: string;
  installSource?: InstallSource;
  skipKeyFormatCheck?: boolean;
}

export async function runSetup(
  deps: SetupCommandDeps,
  options: SetupCommandOptions = {},
): Promise<CommandResult> {
  const isReplace = await deps.configExists();

  let apiKey: string;
  if (isReplace) {
    if (options.apiKey !== undefined) {
      apiKey = options.apiKey.trim();
    } else {
      deps.output.warn('an ingestion key is already configured for this machine');
      deps.output.info('to replace it, type the new ingestion key, then re-enter it to confirm');
      const first = (await deps.prompts.askApiKey()).trim();
      const second = (await deps.prompts.askApiKey('Type the same key again to confirm:')).trim();
      if (first !== second) {
        deps.output.warn('entries did not match; existing key preserved');
        return { exitCode: EXIT_CODE.alreadyInstalled };
      }
      apiKey = first;
    }
  } else {
    apiKey = (options.apiKey ?? (await deps.prompts.askApiKey())).trim();
  }

  if (apiKey.length === 0) {
    deps.output.error('ingestion key is required');
    return { exitCode: EXIT_CODE.validationError };
  }
  if (options.skipKeyFormatCheck !== true && !INGESTION_KEY_PATTERN.test(apiKey)) {
    deps.output.error('ingestion key has invalid format (expected three hyphen-separated parts)');
    return { exitCode: EXIT_CODE.validationError };
  }

  let installedAt: string;
  let installSource: InstallSource;
  let previousHostId: string | null = null;
  let previousUserId: string | null = null;
  if (isReplace) {
    const existing = await loadConfigFromFile(deps.configPath);
    installedAt = existing.account.installedAt;
    installSource = existing.account.installSource;
    previousHostId = existing.account.hostId;
    previousUserId = existing.account.userId;
  } else {
    installedAt = (deps.now ?? nowIsoUtc)();
    installSource = options.installSource ?? 'github_release';
  }

  // verify-key does not consult host_id; pass an empty placeholder while we
  // derive the real, stable id from the verified user id and the machine UUID.
  const http = deps.httpClientFactory(apiKey, '');
  let userId: string;
  try {
    const verification = await http.verifyKey();
    if (!verification.success) {
      deps.output.error(
        verification.message.length > 0
          ? `ingestion key not accepted: ${verification.message}`
          : 'ingestion key not accepted',
      );
      return { exitCode: EXIT_CODE.authError };
    }
    if (verification.userId === null || verification.userId.length === 0) {
      deps.output.error('verify-key response missing user id; cannot derive stable host_id');
      return { exitCode: EXIT_CODE.authError };
    }
    userId = verification.userId;
  } catch (err) {
    if (err instanceof AuthError) {
      deps.output.error('ingestion key rejected by server (invalid, revoked, or wrong type)');
      return { exitCode: EXIT_CODE.authError };
    }
    deps.output.error(formatError('verify-key failed', err));
    return { exitCode: EXIT_CODE.error };
  }

  let machineUuid: string;
  try {
    machineUuid = await (deps.readMachineUuid ?? readMachineUuid)();
  } catch (err) {
    deps.output.error(formatError('failed to read machine UUID', err));
    return { exitCode: EXIT_CODE.error };
  }
  const hostId = deriveHostId(machineUuid, userId);

  if (isReplace && previousHostId !== null && previousUserId !== null) {
    if (previousUserId === userId && previousHostId === hostId) {
      deps.output.info('host_id stable (same machine, same user)');
    } else if (previousUserId !== userId) {
      deps.output.info('host_id rederived for new user');
    } else {
      deps.output.info('host_id rederived from machine UUID');
    }
  }

  const config: GatewayConfig = {
    account: { apiKey, userId, hostId, installedAt, installSource },
    backend: {
      ingestUrl: NEST_INGEST_URL,
      verifyKeyUrl: NEST_VERIFY_KEY_URL,
      watermarksUrl: NEST_WATERMARKS_URL,
    },
    capture: {
      pollIntervalSec: DEFAULT_POLL_INTERVAL_SEC,
      bufferPath: deps.bufferDbPath,
      receiptRetentionDays: DEFAULT_RECEIPT_RETENTION_DAYS,
      failedRetentionDays: DEFAULT_FAILED_RETENTION_DAYS,
      bufferSoftPauseBytes: DEFAULT_BUFFER_SOFT_PAUSE_BYTES,
      bufferSoftResumeBytes: DEFAULT_BUFFER_SOFT_RESUME_BYTES,
      initialScanWindowDays: DEFAULT_INITIAL_SCAN_WINDOW_DAYS,
      uploadMaxBatchesPerSec: DEFAULT_UPLOAD_MAX_BATCHES_PER_SEC,
      uploadMaxBytesPerMinute: DEFAULT_UPLOAD_MAX_BYTES_PER_MINUTE,
      uploadBackoffOn429Multiplier: DEFAULT_UPLOAD_BACKOFF_ON_429_MULTIPLIER,
    },
    logging: { level: 'info', logDir: deps.logDir },
    staleBinary: {
      warnAfterDays: DEFAULT_STALE_WARN_DAYS,
      pauseAfterDays: DEFAULT_STALE_PAUSE_DAYS,
    },
  };

  await ensureDir(dirname(deps.configPath));
  await writeConfigToFile(config, deps.configPath);
  await ensureDir(deps.logDir);

  // Successful verify-key implies the new key is valid. Clear any previous
  // halt sentinel so a halted daemon resumes on its next cycle.
  await clearAuthFailedSentinel(deps.authFailedSentinelPath);

  if (deps.serviceUnitPath !== null) {
    await ensureDir(dirname(deps.serviceUnitPath));
    if (deps.platform === 'win32') {
      const userIdInput: { userId?: string } =
        deps.windowsUserId !== undefined ? { userId: deps.windowsUserId } : {};
      const xml = buildScheduledTaskXml({
        programPath: deps.programPath,
        ...userIdInput,
      });
      await writeAtomic(deps.serviceUnitPath, encodeScheduledTaskXml(xml));
    } else {
      const unit =
        deps.platform === 'darwin'
          ? buildLaunchdPlist({ programPath: deps.programPath })
          : buildSystemdUnit({ programPath: deps.programPath });
      await writeAtomic(deps.serviceUnitPath, unit);
      await setMode(deps.serviceUnitPath, 0o644);
    }
  }

  if (isReplace) {
    deps.output.success(`replaced (host_id: ${hostId})`);
  } else {
    deps.output.success(`installed (host_id: ${hostId})`);
  }
  return { exitCode: EXIT_CODE.ok };
}

function formatError(prefix: string, err: unknown): string {
  if (err instanceof GatewayError) return `${prefix}: ${err.message}`;
  return `${prefix}: ${(err as Error).message ?? String(err)}`;
}
