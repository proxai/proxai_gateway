import { existsSync } from 'node:fs';

import { getServiceManager } from 'cli/service-manager';
import type { ServiceManager } from 'cli/service-manager';
import { platformServiceUnitPath } from 'cli/wiring/platform.ts';
import { buildProfileContext, profileRootDir } from 'core/io/fs/profile.ts';
import type { ProfileContext } from 'core/io/fs/profile.types.ts';
import { PACKAGE_VERSION } from 'core/utils';
import type {
  CoordinatedUpgradeDeps,
  UpgradePostRespawnRestoreDeps,
} from 'services/upgrade/coordinated-upgrade.ts';
import { downloadAsset, replaceBinary } from 'services/upgrade/release-fetch.ts';
import { checkLatestVersion } from 'services/polling/version-check.ts';

function buildNullServiceManager(): ServiceManager {
  return {
    ensureRegistered: async () => {},
    start: async () => {},
    stop: async () => {},
    restart: async () => {},
    unregister: async () => {},
    isRegistered: async () => false,
    isRunning: async () => false,
    runtimeInfo: async () => ({ pid: null, startedAt: null }),
  };
}

function buildDevServiceManager(platform: NodeJS.Platform, devConfigDir: string): ServiceManager {
  const devUnitPath = platformServiceUnitPath(platform, devConfigDir);
  if (devUnitPath === null) return buildNullServiceManager();
  return getServiceManager({ platform, unitPath: devUnitPath, profile: 'dev' });
}

export interface BuildCoordinatedUpgradeDepsInput {
  readonly binaryPath: string;
  readonly platform: NodeJS.Platform;
  readonly overrides?:
    | {
        readonly rootDir?: string;
        readonly devCtx?: ProfileContext;
      }
    | undefined;
}

export function buildCoordinatedUpgradeDeps(
  input: BuildCoordinatedUpgradeDepsInput,
): CoordinatedUpgradeDeps {
  const devCtx = input.overrides?.devCtx ?? buildProfileContext('dev');

  return {
    rootDir: input.overrides?.rootDir ?? profileRootDir(),
    devCtx,
    devServiceManager: buildDevServiceManager(input.platform, devCtx.configDir),
    devConfigExists: () => existsSync(devCtx.configFilePath),
    downloadAndReplaceBinary: async () => {
      const arch = process.arch;
      const platform = input.platform;
      const outcome = await checkLatestVersion({
        currentVersion: PACKAGE_VERSION,
        platform,
        arch,
      });
      if (outcome.kind !== 'ok') return;
      if (!outcome.result.hasUpdate) return;
      const assetUrl = outcome.result.assetUrl;
      if (assetUrl === undefined) return;
      const bytes = await downloadAsset(assetUrl, {
        userAgent: 'proxai-gateway-auto-upgrade',
      });
      if (bytes.byteLength <= 0) return;
      await replaceBinary(input.binaryPath, bytes, platform);
    },
  };
}

export interface BuildUpgradePostRespawnRestoreDepsInput {
  readonly platform: NodeJS.Platform;
  readonly overrides?:
    | {
        readonly rootDir?: string;
        readonly devCtx?: ProfileContext;
      }
    | undefined;
}

export function buildUpgradePostRespawnRestoreDeps(
  input: BuildUpgradePostRespawnRestoreDepsInput,
): UpgradePostRespawnRestoreDeps {
  const devCtx = input.overrides?.devCtx ?? buildProfileContext('dev');

  return {
    rootDir: input.overrides?.rootDir ?? profileRootDir(),
    devCtx,
    devServiceManager: buildDevServiceManager(input.platform, devCtx.configDir),
    devConfigExists: () => existsSync(devCtx.configFilePath),
  };
}

export function buildRunCoordinatedUpgradeDeps(input: {
  readonly binaryPath: string;
  readonly platform: NodeJS.Platform;
  readonly isDev: boolean;
  readonly overrides?: {
    readonly rootDir?: string;
    readonly devCtx?: ProfileContext;
  };
}): CoordinatedUpgradeDeps | undefined {
  if (input.isDev) return undefined;
  const devCtx = input.overrides?.devCtx ?? buildProfileContext('dev');
  if (!existsSync(devCtx.configFilePath)) return undefined;
  return buildCoordinatedUpgradeDeps({
    binaryPath: input.binaryPath,
    platform: input.platform,
    overrides: input.overrides,
  });
}
