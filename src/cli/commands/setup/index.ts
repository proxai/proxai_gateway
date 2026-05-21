import chalk from 'chalk';

import { sentinelHandle } from 'core/io/fs';
import { nowIsoUtc } from 'core/utils';
import { EXIT_CODE } from 'cli/cli.constants.ts';
import type { CommandResult } from 'cli/cli.types.ts';
import { loadConfigFromFile } from 'services/config';
import type { InstallSource } from 'services/config';
import { clearAuthFailedSentinel } from 'services/polling/auth-failed-sentinel.ts';

import { buildGatewayConfig, writeConfigArtifacts } from 'cli/commands/setup/build-config.ts';
import { autoStartDaemon, writeServiceUnitIfNeeded } from 'cli/commands/setup/install-and-start.ts';
import { acquireApiKey } from 'cli/commands/setup/key-flow.ts';
import type { SetupCommandDeps, SetupCommandOptions } from 'cli/commands/setup/setup.types.ts';
import { verifyAndRegister } from 'cli/commands/setup/verify-and-register.ts';

export type { SetupCommandDeps, SetupCommandOptions } from 'cli/commands/setup/setup.types.ts';

export async function runSetup(
  deps: SetupCommandDeps,
  options: SetupCommandOptions = {},
): Promise<CommandResult> {
  const isReplace = await deps.configExists();

  if (isReplace && options.apiKey === undefined && options.force !== true) {
    return reportAlreadyConfigured(deps);
  }

  const keyResult = await acquireApiKey(deps, options, isReplace);
  if (!keyResult.ok) return keyResult.result;
  const apiKey = keyResult.apiKey;

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

  const verifyResult = await verifyAndRegister(deps, apiKey, isReplace, {
    hostId: previousHostId,
    userId: previousUserId,
  });
  if (!verifyResult.ok) return verifyResult.result;

  const config = buildGatewayConfig({
    apiKey,
    userId: verifyResult.userId,
    hostId: verifyResult.hostId,
    installedAt,
    installSource,
    bufferDbPath: deps.bufferDbPath,
    logDir: deps.logDir,
  });
  await writeConfigArtifacts(config, deps);
  await clearAuthFailedSentinel(deps.authFailedSentinelPath);
  await writeServiceUnitIfNeeded(deps);

  if (!isReplace) {
    await maybeWriteConsentSentinel(deps);
  }

  if (isReplace) {
    deps.output.success(`replaced (host_id: ${verifyResult.hostId})`);
  } else {
    deps.output.success(`installed (host_id: ${verifyResult.hostId})`);
  }

  return autoStartDaemon(deps, options);
}

async function maybeWriteConsentSentinel(deps: SetupCommandDeps): Promise<void> {
  if (deps.consentSentinelPath === undefined) return;
  try {
    const handle = sentinelHandle(deps.consentSentinelPath);
    if (await handle.exists()) return;
    const stamp = (deps.now ?? nowIsoUtc)();
    await handle.write(stamp);
  } catch {}
}

async function reportAlreadyConfigured(deps: SetupCommandDeps): Promise<CommandResult> {
  try {
    const existing = await loadConfigFromFile(deps.configPath);
    deps.output.info(`already configured (host_id: ${existing.account.hostId})`);
    deps.output.info(`  installed at  ${existing.account.installedAt}`);
    deps.output.info(`  install src   ${existing.account.installSource}`);
    deps.output.info('');
    deps.output.info(
      `Run ${chalk.cyan('proxai-gateway setup --force')} to re-enter your ingestion key, or ${chalk.cyan('proxai-gateway uninstall --reset')} to wipe and start fresh.`,
    );
  } catch {
    deps.output.info(
      `already configured. Run ${chalk.cyan('proxai-gateway setup --force')} to re-enter your ingestion key, or ${chalk.cyan('proxai-gateway uninstall --reset')} to wipe and start fresh.`,
    );
  }
  return { exitCode: EXIT_CODE.alreadyInstalled };
}
