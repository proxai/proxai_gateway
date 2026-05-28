import chalk from 'chalk';
import { mkdir } from 'node:fs/promises';

import { EXIT_CODE } from 'cli/cli.constants.ts';
import type { CommandResult, OutputSink } from 'cli/cli.types.ts';
import { writeAtomic, sentinelHandle } from 'core/io/fs';
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
  readonly registerDevServiceUnit: () => Promise<void>;
}

export async function runDev(
  deps: DevCommandDeps,
  action?: string,
  args?: { apiKey?: string },
): Promise<CommandResult> {
  if (action === 'setup') {
    return runDevSetup(deps, args?.apiKey);
  }

  const isOn = await readDevModeSentinel(deps.devModeSentinelPath);

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
  const bootId = await readBootId();
  await writeAtomic(deps.devModeSentinelPath, JSON.stringify({ bootId }));

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
  deps.output.success('Dev mode off. Dev daemon continues running in the background.');
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
    deps.output.error('dev ingestion key not accepted');
    return { exitCode: EXIT_CODE.authError };
  }

  try {
    await mkdir(deps.devCtx.configDir, { recursive: true });
  } catch {}

  try {
    await deps.writeDevConfig(deps.devCtx, apiKey);
  } catch (err) {
    deps.output.error(
      `failed to write dev config: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { exitCode: EXIT_CODE.error };
  }

  if (deps.devServiceManager !== null) {
    try {
      await deps.registerDevServiceUnit();
      await deps.devServiceManager.start();
    } catch (err) {
      deps.output.warn(
        `dev service unit registration failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const devOnResult = await runDevOn(deps);
  if (devOnResult.exitCode !== EXIT_CODE.ok) return devOnResult;

  deps.output.success('Dev setup complete. Dev daemon started.');
  return { exitCode: EXIT_CODE.ok };
}
