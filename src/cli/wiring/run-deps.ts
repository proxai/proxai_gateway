import type { RunCommandDeps } from 'cli/commands/run';
import { consoleOutput } from 'cli/output.ts';
import { buildRunCoordinatedUpgradeDeps } from 'cli/wiring/upgrade-restore-deps.ts';
import type { ProfileContext } from 'core/io/fs/profile.types.ts';
import { GATEWAY_USER_AGENT, PACKAGE_VERSION } from 'core/utils';
import type { GatewayConfig } from 'services/config';
import { loadDesktopCliSessionIds } from 'sources/claude-desktop';
import { loadExcludedProjects } from 'services/exclusion';

export interface BuildRunDepsInputs {
  config: GatewayConfig;
  abortSignal: AbortSignal;
  binaryPath: string;
  exitProcess: () => void;
  xstateInspect?: boolean | undefined;
  profileCtx: ProfileContext;
  platform?: NodeJS.Platform;
}

export function buildRunDeps(inputs: BuildRunDepsInputs): RunCommandDeps {
  const platform = inputs.platform ?? process.platform;
  const env = process.env;
  // Fail-safe fallback for the per-cycle exclusion read: the LAST SUCCESSFULLY-read
  // list, seeded from the startup config. A bare startup-list fallback would
  // transiently leak a CLI-added exclusion if a later cycle's config.toml read
  // failed; tracking last-good keeps runtime `exclude` additions protected too.
  let lastGoodExcluded: readonly string[] = inputs.config.capture.excludedProjects;
  const deps: RunCommandDeps = {
    profileCtx: inputs.profileCtx,
    output: consoleOutput(),
    config: inputs.config,
    authFailedSentinelPath: inputs.profileCtx.sentinels.authFailed,
    bufferFullSentinelPath: inputs.profileCtx.sentinels.bufferFull,
    sessionStoppedSentinelPath: inputs.profileCtx.sentinels.sessionStopped,
    updateAvailableSentinelPath: inputs.profileCtx.sentinels.updateAvailable,
    abortSignal: inputs.abortSignal,
    gatewayVersion: GATEWAY_USER_AGENT,
    currentVersion: PACKAGE_VERSION,
    binaryPath: inputs.binaryPath,
    installSource: inputs.config.account.installSource,
    devMode: inputs.profileCtx.isDev,
    exitProcess: inputs.exitProcess,
    loadDesktopCliSessionIds: () => loadDesktopCliSessionIds(platform, env),
    loadExcludedProjects: async (logger) => {
      const result = await loadExcludedProjects(
        inputs.profileCtx.configFilePath,
        lastGoodExcluded,
        logger,
      );
      lastGoodExcluded = result; // advance the fail-safe baseline on every successful read
      return result;
    },
  };
  if (inputs.xstateInspect !== undefined) {
    deps.xstateInspect = inputs.xstateInspect;
  }
  const coordDeps = buildRunCoordinatedUpgradeDeps({
    binaryPath: inputs.binaryPath,
    platform,
    isDev: inputs.profileCtx.isDev,
  });
  if (coordDeps !== undefined) {
    deps.coordinatedUpgradeDeps = coordDeps;
  }
  return deps;
}
