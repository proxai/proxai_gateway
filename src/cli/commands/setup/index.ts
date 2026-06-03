import chalk from 'chalk';
import { createActor } from 'xstate';
import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';

import { sentinelHandle } from 'core/io/fs';
import { nowIsoUtc } from 'core/utils';
import { formatTimeWithRelative } from 'core/utils/format.ts';
import { EXIT_CODE } from 'cli/cli.constants.ts';
import type { CommandResult } from 'cli/cli.types.ts';
import { clearFailedState, openBufferDb } from 'services/buffer';
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
  if (await deps.configExists()) {
    return showSetupStatus(deps, options.apiKey !== undefined);
  }
  return runConfigure(deps, options);
}

export async function runSetupNew(
  deps: SetupCommandDeps,
  options: SetupCommandOptions = {},
): Promise<CommandResult> {
  return runConfigure(deps, options);
}

async function runConfigure(
  deps: SetupCommandDeps,
  options: SetupCommandOptions,
): Promise<CommandResult> {
  const isReplace = await deps.configExists();
  const machine = createActor(setupMachine);
  machine.start();
  machine.send({ type: 'CONSENT_ACCEPTED' });

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
    defaultNestBaseUrl: deps.defaultNestBaseUrl,
  });
  await writeConfigArtifacts(config, deps);
  machine.send({ type: 'CONFIG_WRITTEN' });
  await clearAuthFailedSentinel(deps.authFailedSentinelPath);
  await clearFailedAndSentinels(deps);
  await writeServiceUnitIfNeeded(deps);

  if (!isReplace) {
    await maybeWriteConsentSentinel(deps);
  }
  machine.send({ type: 'SENTINEL_WRITTEN' });

  if (isReplace) {
    deps.output.success(`gateway key replaced (host_id: ${verifyResult.hostId})`);
  } else {
    deps.output.success(`installed (host_id: ${verifyResult.hostId})`);
  }

  const result = await autoStartDaemon(deps, options);
  machine.stop();
  return result;
}

async function showSetupStatus(
  deps: SetupCommandDeps,
  keyProvided = false,
): Promise<CommandResult> {
  const config = await tryLoadExistingConfig(deps);
  if (config === null) {
    deps.output.info('Gateway is configured, but the configuration could not be read.');
    return { exitCode: EXIT_CODE.alreadyInstalled };
  }

  if (keyProvided) {
    deps.output.info('proxai-gateway is already configured — your gateway key was not changed.');
    deps.output.info('');
  }

  const lastSuccessAt =
    deps.readLastSuccessAt !== undefined ? await deps.readLastSuccessAt() : null;
  const nowDate = deps.now !== undefined ? new Date(deps.now()) : undefined;
  const lastUpload =
    lastSuccessAt !== null
      ? formatTimeWithRelative(lastSuccessAt, nowDate !== undefined ? { now: nowDate } : {})
      : null;

  deps.output.info(`  ${chalk.green('●')} proxai-gateway — configured`);
  deps.output.info(`    ├─ Gateway key : ${chalk.cyan(maskKey(config.account.apiKey))}`);
  deps.output.info(
    `    └─ Last upload : ${lastUpload !== null ? chalk.cyan(lastUpload) : chalk.dim('no successful upload yet')}`,
  );
  deps.output.info('');
  deps.output.info(`To replace your gateway key, run ${chalk.cyan('proxai-gateway setup new')}.`);
  deps.output.info(
    `To clear it and reconfigure later, run ${chalk.cyan('proxai-gateway setup reset')}.`,
  );
  return { exitCode: EXIT_CODE.alreadyInstalled };
}

export async function runSetupReset(
  deps: SetupCommandDeps,
  options: SetupCommandOptions = {},
): Promise<CommandResult> {
  if (!(await deps.configExists())) {
    deps.output.info('Gateway is not configured — nothing to reset.');
    return { exitCode: EXIT_CODE.ok };
  }

  if (options.yes !== true) {
    const confirmed = await deps.prompts.confirmPhrase(
      `This stops the daemon and removes your gateway key. Buffered data and logs are kept. Type ${chalk.cyan('setup reset')} to confirm, or anything else to abort.`,
      'setup reset',
    );
    if (!confirmed) {
      deps.output.info('aborted — nothing changed');
      return { exitCode: EXIT_CODE.alreadyInstalled };
    }
  }

  if (deps.serviceManager !== undefined) {
    try {
      await deps.serviceManager.stop();
    } catch {}
    try {
      await deps.serviceManager.unregister();
    } catch {}
  }
  if (deps.serviceUnitPath !== null) {
    try {
      await unlink(deps.serviceUnitPath);
    } catch {}
  }
  try {
    await unlink(deps.configPath);
  } catch {}
  await clearAuthFailedSentinel(deps.authFailedSentinelPath);
  await clearFailedAndSentinels(deps);
  if (deps.sessionStoppedSentinelPath !== undefined) {
    try {
      await sentinelHandle(deps.sessionStoppedSentinelPath).remove();
    } catch {}
  }

  deps.output.success('gateway key removed — gateway is waiting for configuration.');
  deps.output.info(`Run ${chalk.cyan('proxai-gateway setup')} to configure a new gateway key.`);
  return { exitCode: EXIT_CODE.ok };
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

async function clearFailedAndSentinels(deps: SetupCommandDeps): Promise<void> {
  if (deps.bufferFullSentinelPath !== undefined) {
    try {
      await sentinelHandle(deps.bufferFullSentinelPath).remove();
    } catch {}
  }
  if (existsSync(deps.bufferDbPath)) {
    try {
      const db = openBufferDb(deps.bufferDbPath);
      try {
        clearFailedState(db);
      } finally {
        db.close();
      }
    } catch {}
  }
}
