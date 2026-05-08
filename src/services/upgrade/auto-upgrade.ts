import type { Logger } from 'core/log';
import type { InstallSource } from 'services/config';
import { checkLatestVersion } from 'services/polling/version-check.ts';
import { downloadAsset, expectedAssetName, replaceBinary } from 'services/upgrade/release-fetch.ts';

export interface AutoUpgradeDeps {
  binaryPath: string;
  currentVersion: string;
  devMode?: boolean;
  installSource?: InstallSource;
  fetch?: typeof globalThis.fetch;
  logger?: Logger;
  exitProcess?: () => void;
  platform?: NodeJS.Platform;
  arch?: string;
}

export async function runAutoUpgrade(deps: AutoUpgradeDeps): Promise<void> {
  if (deps.devMode === true) return;
  if (deps.installSource === 'brew') return;

  const log = deps.logger;
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;

  const checkOpts: Parameters<typeof checkLatestVersion>[0] = {
    currentVersion: deps.currentVersion,
    platform,
    arch,
  };
  if (deps.fetch !== undefined) checkOpts.fetch = deps.fetch;

  const outcome = await checkLatestVersion(checkOpts);

  if (outcome.kind === 'error') {
    log?.fatal(
      { event: 'auto_upgrade.check_failed', reason: outcome.reason },
      'auto-upgrade version check failed',
    );
    return;
  }
  if (outcome.kind === 'no_release') return;
  if (!outcome.result.hasUpdate) return;

  const assetUrl = outcome.result.assetUrl;
  if (assetUrl === undefined) {
    log?.fatal(
      { event: 'auto_upgrade.no_asset', expected: expectedAssetName(platform, arch) },
      'auto-upgrade found no platform-matching asset',
    );
    return;
  }

  let bytes: Uint8Array;
  try {
    const dlOpts: Parameters<typeof downloadAsset>[1] = {
      userAgent: 'proxai-gateway-auto-upgrade',
    };
    if (deps.fetch !== undefined) dlOpts.fetch = deps.fetch;
    bytes = await downloadAsset(assetUrl, dlOpts);
  } catch (err) {
    log?.fatal(
      { event: 'auto_upgrade.download_failed', error: (err as Error).message ?? String(err) },
      'auto-upgrade download failed',
    );
    return;
  }

  if (bytes.byteLength <= 0) {
    log?.fatal(
      { event: 'auto_upgrade.download_failed', error: 'empty body' },
      'auto-upgrade download produced empty body',
    );
    return;
  }

  try {
    await replaceBinary(deps.binaryPath, bytes, platform);
  } catch (err) {
    log?.fatal(
      { event: 'auto_upgrade.write_failed', error: (err as Error).message ?? String(err) },
      'auto-upgrade failed to replace binary',
    );
    return;
  }

  log?.info(
    {
      event: 'auto_upgrade.success',
      latest: outcome.result.latestVersion,
      current: deps.currentVersion,
    },
    'auto-upgrade installed; restarting',
  );
  deps.exitProcess?.();
}
