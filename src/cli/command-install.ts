import { ensureDir, setMode, writeAtomic } from 'core/io/fs';
import { dirname } from 'node:path';

import { AuthError, GatewayError, generateUuidV7, nowIsoUtc } from 'core/utils';
import { EXIT_CODE } from 'cli/cli.constants.ts';
import type { CommandResult, OutputSink } from 'cli/cli.types.ts';
import { buildLaunchdPlist } from 'cli/launchd-plist.ts';
import type { PromptSink } from 'cli/prompts.ts';
import { buildSystemdUnit } from 'cli/systemd-unit.ts';
import {
  DEFAULT_BUFFER_MAX_BYTES,
  DEFAULT_INGEST_URL,
  DEFAULT_POLL_INTERVAL_SEC,
  DEFAULT_STALE_PAUSE_DAYS,
  DEFAULT_STALE_WARN_DAYS,
  DEFAULT_VERIFY_KEY_URL,
} from 'services/config';
import type { GatewayConfig, InstallSource } from 'services/config';
import { writeConfigToFile } from 'services/config';
import { HttpClient } from 'services/http';

const INGESTION_KEY_PATTERN = /^[A-Za-z0-9]+-\d{8,}-[A-Za-z0-9]+$/;

export interface InstallCommandDeps {
  output: OutputSink;
  prompts: PromptSink;
  configPath: string;
  bufferDbPath: string;
  logDir: string;
  serviceUnitPath: string | null;
  programPath: string;
  configExists: () => Promise<boolean>;
  httpClientFactory: (apiKey: string, hostId: string) => HttpClient;
  generateHostId?: () => string;
  now?: () => string;
  platform: NodeJS.Platform;
}

export interface InstallCommandOptions {
  apiKey?: string;
  yes?: boolean;
  installSource?: InstallSource;
  skipKeyFormatCheck?: boolean;
}

export async function runInstall(
  deps: InstallCommandDeps,
  options: InstallCommandOptions = {},
): Promise<CommandResult> {
  if (await deps.configExists()) {
    if (options.yes !== true) {
      const overwrite = await deps.prompts.confirmOverwrite(
        `${deps.configPath} already exists. Overwrite?`,
      );
      if (!overwrite) {
        deps.output.warn('install aborted (existing config preserved)');
        return { exitCode: EXIT_CODE.alreadyInstalled };
      }
    }
  }

  const apiKey = (options.apiKey ?? (await deps.prompts.askApiKey())).trim();
  if (apiKey.length === 0) {
    deps.output.error('ingestion key is required');
    return { exitCode: EXIT_CODE.validationError };
  }
  if (options.skipKeyFormatCheck !== true && !INGESTION_KEY_PATTERN.test(apiKey)) {
    deps.output.error('ingestion key has invalid format (expected three hyphen-separated parts)');
    return { exitCode: EXIT_CODE.validationError };
  }

  const hostId = (deps.generateHostId ?? generateUuidV7)();
  const installedAt = (deps.now ?? nowIsoUtc)();
  const installSource: InstallSource = options.installSource ?? 'github_release';

  const http = deps.httpClientFactory(apiKey, hostId);
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
  } catch (err) {
    if (err instanceof AuthError) {
      deps.output.error('ingestion key rejected by server (invalid, revoked, or wrong type)');
      return { exitCode: EXIT_CODE.authError };
    }
    deps.output.error(formatError('verify-key failed', err));
    return { exitCode: EXIT_CODE.error };
  }

  const config: GatewayConfig = {
    account: { apiKey, hostId, installedAt, installSource },
    backend: {
      ingestUrl: DEFAULT_INGEST_URL,
      verifyKeyUrl: DEFAULT_VERIFY_KEY_URL,
    },
    capture: {
      pollIntervalSec: DEFAULT_POLL_INTERVAL_SEC,
      bufferPath: deps.bufferDbPath,
      bufferMaxBytes: DEFAULT_BUFFER_MAX_BYTES,
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

  if (deps.serviceUnitPath !== null) {
    await ensureDir(dirname(deps.serviceUnitPath));
    const unit =
      deps.platform === 'darwin'
        ? buildLaunchdPlist({ programPath: deps.programPath })
        : buildSystemdUnit({ programPath: deps.programPath });
    await writeAtomic(deps.serviceUnitPath, unit);
    await setMode(deps.serviceUnitPath, 0o644);
    deps.output.info(`service unit: ${deps.serviceUnitPath}`);
  }

  deps.output.success(`installed (host_id: ${hostId})`);
  deps.output.info(`config: ${deps.configPath}`);
  return { exitCode: EXIT_CODE.ok };
}

function formatError(prefix: string, err: unknown): string {
  if (err instanceof GatewayError) return `${prefix}: ${err.message}`;
  return `${prefix}: ${(err as Error).message ?? String(err)}`;
}
