import chalk from 'chalk';
import { createActor } from 'xstate';

import { sentinelHandle } from 'core/io/fs';
import { nowIsoUtc } from 'core/utils';
import { EXIT_CODE } from 'cli/cli.constants.ts';
import type { CommandResult } from 'cli/cli.types.ts';
import { loadConfigFromFile } from 'services/config';
import type { GatewayConfig, InstallSource } from 'services/config';
import { clearAuthFailedSentinel } from 'services/polling/auth-failed-sentinel.ts';
import { setupMachine } from 'services/state-machines/setup';

import { buildGatewayConfig, writeConfigArtifacts } from 'cli/commands/setup/build-config.ts';
import { autoStartDaemon, writeServiceUnitIfNeeded } from 'cli/commands/setup/install-and-start.ts';
import { acquireApiKey } from 'cli/commands/setup/key-flow.ts';
import type { SetupCommandDeps, SetupCommandOptions } from 'cli/commands/setup/setup.types.ts';
import { verifyAndRegister } from 'cli/commands/setup/verify-and-register.ts';

function maskKey(key: string): string {
  if (key.length <= 8) return '***';
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

export type { SetupCommandDeps, SetupCommandOptions } from 'cli/commands/setup/setup.types.ts';

export async function runSetup(
  deps: SetupCommandDeps,
  options: SetupCommandOptions = {},
): Promise<CommandResult> {
  const machine = createActor(setupMachine);
  machine.start();
  machine.send({ type: 'CONSENT_ACCEPTED' });

  const isReplace = await deps.configExists();
  const providedKey = options.apiKey?.trim();
  const hasProvidedKey = providedKey !== undefined && providedKey.length > 0;

  if (isReplace && options.force !== true) {
    const existing = await tryLoadExistingConfig(deps);
    if (hasProvidedKey && existing !== null && existing.account.apiKey !== providedKey) {
      const wantsReplace = await deps.prompts.confirmReplace(
        `This machine is already configured with ingestion key ${chalk.cyan(maskKey(existing.account.apiKey))}. Replace it with the new key ${chalk.cyan(maskKey(providedKey))}?`,
      );
      if (!wantsReplace) {
        deps.output.info('aborted — keeping existing configuration');
        machine.stop();
        return reportAlreadyConfiguredAndMaybeStart(deps, options, existing);
      }
      // user confirmed override → fall through to the full setup flow below
    } else {
      machine.stop();
      return reportAlreadyConfiguredAndMaybeStart(deps, options, existing);
    }
  }

  const keyResult = await acquireApiKey(deps, options, isReplace);
  if (!keyResult.ok) {
    machine.send({ type: 'ERROR', message: 'key acquisition failed' });
    machine.stop();
    return keyResult.result;
  }
  const apiKey = keyResult.apiKey;
  machine.send({ type: 'KEY_PROVIDED', maskedKey: maskKey(apiKey) });

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
  if (!verifyResult.ok) {
    machine.send({ type: 'KEY_VERIFY_FAILURE', reason: 'verify-and-register failed' });
    machine.stop();
    return verifyResult.result;
  }
  machine.send({ type: 'KEY_VERIFY_SUCCESS' });

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
  machine.send({ type: 'CONFIG_WRITTEN' });
  await clearAuthFailedSentinel(deps.authFailedSentinelPath);
  await writeServiceUnitIfNeeded(deps);

  if (!isReplace) {
    await maybeWriteConsentSentinel(deps);
  }
  machine.send({ type: 'SENTINEL_WRITTEN' });

  if (isReplace) {
    deps.output.success(`replaced (host_id: ${verifyResult.hostId})`);
  } else {
    deps.output.success(`installed (host_id: ${verifyResult.hostId})`);
  }

  const result = await autoStartDaemon(deps, options);
  machine.stop();
  return result;
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

async function tryLoadExistingConfig(deps: SetupCommandDeps): Promise<GatewayConfig | null> {
  try {
    return await loadConfigFromFile(deps.configPath);
  } catch {
    return null;
  }
}

async function reportAlreadyConfiguredAndMaybeStart(
  deps: SetupCommandDeps,
  options: SetupCommandOptions,
  existing: GatewayConfig | null,
): Promise<CommandResult> {
  if (existing !== null) {
    deps.output.info(`already configured (host_id: ${existing.account.hostId})`);
    deps.output.info(`  installed at  ${existing.account.installedAt}`);
    deps.output.info(`  install src   ${existing.account.installSource}`);
  } else {
    deps.output.info('already configured (could not read existing config)');
  }
  deps.output.info('');

  if (options.noStart === true) {
    deps.output.info(
      `Run ${chalk.cyan('proxai-gateway setup --force')} to re-enter your ingestion key, or ${chalk.cyan('proxai-gateway uninstall --reset')} to wipe and start fresh.`,
    );
    return { exitCode: EXIT_CODE.alreadyInstalled };
  }

  if (deps.serviceManager === undefined) {
    deps.output.info(
      `Run ${chalk.cyan('proxai-gateway setup --force')} to re-enter your ingestion key, or ${chalk.cyan('proxai-gateway uninstall --reset')} to wipe and start fresh.`,
    );
    return { exitCode: EXIT_CODE.alreadyInstalled };
  }

  let running = false;
  try {
    running = await deps.serviceManager.isRunning();
  } catch {
    running = false;
  }
  if (running) {
    deps.output.info(
      `Daemon is running. View live status with ${chalk.cyan('proxai-gateway status')}.`,
    );
    return { exitCode: EXIT_CODE.alreadyInstalled };
  }

  deps.output.info('Daemon is not running — starting it now.');
  await writeServiceUnitIfNeeded(deps);
  return autoStartDaemon(deps, options);
}
