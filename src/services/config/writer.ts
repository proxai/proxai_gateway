import { stringify as stringifyToml } from 'smol-toml';

import { configFilePath, setMode, writeAtomic } from 'core/io/fs';
import type { GatewayConfig } from 'services/config/config.types.ts';

export async function writeConfigToFile(config: GatewayConfig, path?: string): Promise<void> {
  const filePath = path ?? configFilePath();
  const text = serializeConfig(config);
  await writeAtomic(filePath, text);
  await setMode(filePath, 0o600);
}

export function serializeConfig(config: GatewayConfig): string {
  return stringifyToml({
    account: {
      api_key: config.account.apiKey,
      user_id: config.account.userId,
      host_id: config.account.hostId,
      installed_at: config.account.installedAt,
      install_source: config.account.installSource,
    },
    backend: {
      ingest_url: config.backend.ingestUrl,
      verify_key_url: config.backend.verifyKeyUrl,
      watermarks_url: config.backend.watermarksUrl,
      register_host_id_url: config.backend.registerHostIdUrl,
    },
    capture: {
      poll_interval_sec: config.capture.pollIntervalSec,
      buffer_path: config.capture.bufferPath,
      receipt_retention_days: config.capture.receiptRetentionDays,
      failed_retention_days: config.capture.failedRetentionDays,
      buffer_soft_pause_bytes: config.capture.bufferSoftPauseBytes,
      buffer_soft_resume_bytes: config.capture.bufferSoftResumeBytes,
      upload_max_batches_per_sec: config.capture.uploadMaxBatchesPerSec,
      upload_max_bytes_per_minute: config.capture.uploadMaxBytesPerMinute,
      upload_backoff_on_429_multiplier: config.capture.uploadBackoffOn429Multiplier,
      ...(config.capture.maxDecompressedBytes !== undefined &&
      Number.isFinite(config.capture.maxDecompressedBytes)
        ? { max_decompressed_bytes: config.capture.maxDecompressedBytes }
        : {}),
    },
    logging: {
      level: config.logging.level,
      log_dir: config.logging.logDir,
    },
    stale_binary: {
      warn_after_days: config.staleBinary.warnAfterDays,
      pause_after_days: config.staleBinary.pauseAfterDays,
    },
  });
}
