import chalk from 'chalk';

import { EXIT_CODE } from 'cli/cli.constants.ts';
import type { CommandResult, OutputSink } from 'cli/cli.types.ts';
import { AuthError } from 'core/utils';
import { writeAtomic, sentinelHandle } from 'core/io/fs';
import { setMode, ensureSecureBaseDirs } from 'core/io/fs/mode.ts';
import { readDevModeSentinel } from 'core/io/fs/dev-mode-sentinel.ts';
import { readBootId } from 'core/system/boot-id.ts';
import type { ServiceManager } from 'cli/service-manager';
import type { ProfileContext } from 'core/io/fs/profile.types.ts';

export interface DevCommandDeps {
  readonly output: OutputSink;
  readonly devModeSentinelPath: string;
  readonly devCtx: ProfileContext;
  readonly devConfigExists: () => Promise<boolean>;
  readonly devServiceManager: ServiceManager | null;
  readonly verifyKey: (url: string, apiKey: string) => Promise<{ success: boolean }>;
  readonly writeDevConfig: (profileCtx: ProfileContext, apiKey: string) => Promise<void>;
  readonly registerDevHostId: (apiKey: string) => Promise<{ registered: boolean }>;
  readonly clearAuthFailed: () => Promise<void>;
  readonly registerDevServiceUnit: () => Promise<void>;
  readonly readBootId?: () => Promise<string>;
}

export async function runDev(
  deps: DevCommandDeps,
  action?: string,
  args?: { apiKey?: string },
): Promise<CommandResult> {
  if (action === 'setup') {
    return runDevSetup(deps, args?.apiKey);
  }

  const isOn = await readDevModeSentinel(deps.devModeSentinelPath, deps.readBootId ?? readBootId);

  let targetState: boolean;
  if (action === 'on') {
    targetState = true;
  } else if (action === 'off') {
    targetState = false;
  } else if (action === undefined || action.trim() === '') {
    targetState = !isOn;
  } else {
    deps.output.error(
      `Invalid action: '${action}'. Expected 'on', 'off', 'setup', or no action to toggle.`,
    );
    return { exitCode: EXIT_CODE.error };
  }

  if (targetState) {
    return runDevOn(deps);
  }
  return runDevOff(deps);
}

async function runDevOn(deps: DevCommandDeps): Promise<CommandResult> {
  const readBootIdFn = deps.readBootId ?? readBootId;
  const bootId = await readBootIdFn();
  await writeAtomic(deps.devModeSentinelPath, JSON.stringify({ bootId }));
  await setMode(deps.devModeSentinelPath, 0o600);

  const configExists = await deps.devConfigExists();
  if (configExists && deps.devServiceManager !== null) {
    try {
      const running = await deps.devServiceManager.isRunning();
      if (!running) {
        await deps.devServiceManager.start();
        deps.output.success('Dev mode on. Dev daemon started.');
        return { exitCode: EXIT_CODE.ok };
      }
    } catch {}
  }

  if (!configExists) {
    deps.output.success(
      `Dev mode on. Run ${chalk.cyan('proxai-gateway dev setup <KEY>')} to configure the dev daemon.`,
    );
  } else {
    deps.output.success('Dev mode on.');
  }

  return { exitCode: EXIT_CODE.ok };
}

async function runDevOff(deps: DevCommandDeps): Promise<CommandResult> {
  await sentinelHandle(deps.devModeSentinelPath).remove();
  let running = false;
  if (deps.devServiceManager !== null) {
    try {
      running = await deps.devServiceManager.isRunning();
    } catch {}
  }
  if (running) {
    deps.output.success('Dev mode off. The dev daemon continues running in the background.');
  } else {
    deps.output.success('Dev mode off.');
  }
  return { exitCode: EXIT_CODE.ok };
}

async function runDevSetup(
  deps: DevCommandDeps,
  apiKey: string | undefined,
): Promise<CommandResult> {
  if (apiKey === undefined || apiKey.trim().length === 0) {
    deps.output.error('usage: proxai-gateway dev setup <KEY>');
    return { exitCode: EXIT_CODE.validationError };
  }

  const verifyUrl = `${deps.devCtx.defaultNestBaseUrl}/ingestion/verify-key`;
  let verified: { success: boolean };
  try {
    verified = await deps.verifyKey(verifyUrl, apiKey);
  } catch (err) {
    deps.output.error(
      `key verification failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { exitCode: EXIT_CODE.authError };
  }

  if (!verified.success) {
    deps.output.error('dev gateway key not accepted');
    return { exitCode: EXIT_CODE.authError };
  }

  try {
    const registration = await deps.registerDevHostId(apiKey);
    deps.output.info(
      registration.registered ? 'host_id bound on backend' : 'host_id already bound on backend',
    );
  } catch (err) {
    if (err instanceof AuthError) {
      deps.output.error(
        'this dev gateway key is already bound to another machine; create a new dev gateway key',
      );
      return { exitCode: EXIT_CODE.authError };
    }
    deps.output.error(
      `host_id registration failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { exitCode: EXIT_CODE.error };
  }

  try {
    await ensureSecureBaseDirs([deps.devCtx.configDir, deps.devCtx.logDir]);
  } catch {}

  try {
    await deps.writeDevConfig(deps.devCtx, apiKey);
  } catch (err) {
    deps.output.error(
      `failed to write dev config: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { exitCode: EXIT_CODE.error };
  }

  await deps.clearAuthFailed();

  let daemonStarted = false;
  if (deps.devServiceManager !== null) {
    try {
      await deps.registerDevServiceUnit();
      await deps.devServiceManager.start();
      daemonStarted = true;
    } catch (err) {
      deps.output.warn(
        `dev service unit registration failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const devOnResult = await runDevOn(deps);
  if (devOnResult.exitCode !== EXIT_CODE.ok) return devOnResult;

  if (daemonStarted) {
    deps.output.success('Dev setup complete. Dev daemon started.');
  } else {
    deps.output.warn(
      `Dev setup complete — config saved, but the dev daemon did not start. Resolve the error above, then run ${chalk.cyan('proxai-gateway dev on')}.`,
    );
  }
  return { exitCode: EXIT_CODE.ok };
}
