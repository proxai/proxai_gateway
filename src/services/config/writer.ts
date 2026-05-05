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
      host_id: config.account.hostId,
      installed_at: config.account.installedAt,
      install_source: config.account.installSource,
    },
    backend: {
      ingest_url: config.backend.ingestUrl,
      auth_validate_url: config.backend.authValidateUrl,
      health_url: config.backend.healthUrl,
      latest_version_url: config.backend.latestVersionUrl,
      allowed_hosts_url: config.backend.allowedHostsUrl,
    },
    capture: {
      poll_interval_sec: config.capture.pollIntervalSec,
      buffer_path: config.capture.bufferPath,
      buffer_max_bytes: config.capture.bufferMaxBytes,
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
