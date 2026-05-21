import { dirname } from 'node:path';

import { ensureDir } from 'core/io/fs';
import {
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
  NEST_INGEST_URL,
  NEST_REGISTER_HOST_ID_URL,
  NEST_VERIFY_KEY_URL,
  NEST_WATERMARKS_URL,
  writeConfigToFile,
} from 'services/config';
import type { GatewayConfig, InstallSource } from 'services/config';

import type { SetupCommandDeps } from 'cli/commands/setup/setup.types.ts';

export interface BuildAndWriteConfigInputs {
  apiKey: string;
  userId: string;
  hostId: string;
  installedAt: string;
  installSource: InstallSource;
  bufferDbPath: string;
  logDir: string;
}

export function buildGatewayConfig(input: BuildAndWriteConfigInputs): GatewayConfig {
  return {
    account: {
      apiKey: input.apiKey,
      userId: input.userId,
      hostId: input.hostId,
      installedAt: input.installedAt,
      installSource: input.installSource,
    },
    backend: {
      ingestUrl: NEST_INGEST_URL,
      verifyKeyUrl: NEST_VERIFY_KEY_URL,
      watermarksUrl: NEST_WATERMARKS_URL,
      registerHostIdUrl: NEST_REGISTER_HOST_ID_URL,
    },
    capture: {
      pollIntervalSec: DEFAULT_POLL_INTERVAL_SEC,
      bufferPath: input.bufferDbPath,
      receiptRetentionDays: DEFAULT_RECEIPT_RETENTION_DAYS,
      failedRetentionDays: DEFAULT_FAILED_RETENTION_DAYS,
      bufferSoftPauseBytes: DEFAULT_BUFFER_SOFT_PAUSE_BYTES,
      bufferSoftResumeBytes: DEFAULT_BUFFER_SOFT_RESUME_BYTES,
      uploadMaxBatchesPerSec: DEFAULT_UPLOAD_MAX_BATCHES_PER_SEC,
      uploadMaxBytesPerMinute: DEFAULT_UPLOAD_MAX_BYTES_PER_MINUTE,
      uploadBackoffOn429Multiplier: DEFAULT_UPLOAD_BACKOFF_ON_429_MULTIPLIER,
    },
    logging: { level: 'info', logDir: input.logDir },
    staleBinary: {
      warnAfterDays: DEFAULT_STALE_WARN_DAYS,
      pauseAfterDays: DEFAULT_STALE_PAUSE_DAYS,
    },
  };
}

export async function writeConfigArtifacts(
  config: GatewayConfig,
  deps: SetupCommandDeps,
): Promise<void> {
  await ensureDir(dirname(deps.configPath));
  await writeConfigToFile(config, deps.configPath);
  await ensureDir(deps.logDir);
}
