import { compareGatewayVersions } from 'core/utils';
import type { FetchFn } from 'core/utils';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { EXIT_CODE } from 'cli/cli.constants.ts';
import type { CommandResult, OutputSink } from 'cli/cli.types.ts';
import { isLocalBuildPath } from 'cli/commands/status/local-build.ts';
import {
  downloadAsset,
  expectedAssetName,
  fetchLatestRelease,
  findAssetForPlatform,
  replaceBinary,
} from 'services/upgrade/release-fetch.ts';

export interface UpgradeCommandDeps {
  output: OutputSink;
  currentVersion: string;
  binaryPath: string;
  fetch?: FetchFn;
  platform?: NodeJS.Platform;
  restartDaemon?: () => Promise<boolean>;
}

export interface UpgradeCommandOptions {
  force?: boolean;
}

const USER_AGENT = 'proxai-gateway-upgrade';

export async function runUpgrade(
  deps: UpgradeCommandDeps,
  options: UpgradeCommandOptions = {},
): Promise<CommandResult> {
  const isLocal =
    isLocalBuildPath(deps.binaryPath) ||
    deps.binaryPath.includes('src/main.ts') ||
    deps.binaryPath.includes('src\\main.ts') ||
    (typeof process !== 'undefined' &&
      typeof process.argv?.[1] === 'string' &&
      (process.argv[1].includes('src/main.ts') || process.argv[1].includes('src\\main.ts')));

  if (isLocal) {
    const platformOverride = deps.platform ?? process.platform;
    const platform = platformOverride === 'win32' ? 'windows' : platformOverride;
    let target = `${platform}-${process.arch}`;
    const distMatch = deps.binaryPath.match(/[/\\]dist[/\\]([^/\\]+)[/\\]/);
    if (distMatch?.[1]) {
      target = distMatch[1];
    }

    let repoRoot = resolve(deps.binaryPath, '..', '..', '..');
    const pathsToTry = [
      typeof process !== 'undefined' ? process.argv?.[1] : undefined,
      deps.binaryPath,
    ].filter((p): p is string => typeof p === 'string' && p.length > 0);

    for (const startPath of pathsToTry) {
      let currentDir = resolve(startPath);
      try {
        if (existsSync(currentDir) && statSync(currentDir).isFile()) {
          currentDir = dirname(currentDir);
        }
      } catch {
        currentDir = dirname(currentDir);
      }

      let found = false;
      while (currentDir !== dirname(currentDir)) {
        if (
          existsSync(join(currentDir, 'scripts/build.ts')) &&
          existsSync(join(currentDir, 'package.json'))
        ) {
          repoRoot = currentDir;
          found = true;
          break;
        }
        currentDir = dirname(currentDir);
      }
      if (found) {
        break;
      }
    }

    deps.output.info(
      `Local development build detected. Rebuilding target ${target} from source...`,
    );
    const proc = Bun.spawn({
      cmd: ['bun', 'scripts/build.ts', target],
      cwd: repoRoot,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    const code = await proc.exited;
    if (code !== 0) {
      deps.output.error(`Local rebuild failed with exit code ${code}`);
      return { exitCode: EXIT_CODE.error };
    }
    deps.output.success('Local build upgraded successfully.');
    return { exitCode: EXIT_CODE.ok };
  }

  const fetchFn = deps.fetch ?? globalThis.fetch;
  const platform = deps.platform ?? process.platform;
  const arch = process.arch;

  const fetchOpts: Parameters<typeof fetchLatestRelease>[0] = { userAgent: USER_AGENT };
  if (deps.fetch !== undefined) fetchOpts.fetch = fetchFn;
  let release;
  try {
    release = await fetchLatestRelease(fetchOpts);
  } catch (err) {
    deps.output.error(`failed to check for updates: ${(err as Error).message ?? String(err)}`);
    return { exitCode: EXIT_CODE.error };
  }

  const latestVersion = stripV(release.tag_name);
  if (latestVersion.length === 0) {
    deps.output.error(`could not parse version from release tag: ${release.tag_name}`);
    return { exitCode: EXIT_CODE.error };
  }

  const cmp = compareGatewayVersions(latestVersion, deps.currentVersion);
  if (cmp <= 0 && options.force !== true) {
    deps.output.info(`already at latest version: ${deps.currentVersion}`);
    return { exitCode: EXIT_CODE.ok };
  }

  const asset = findAssetForPlatform(release, platform, arch);
  if (asset === undefined) {
    deps.output.error(`no asset found for this platform: ${expectedAssetName(platform, arch)}`);
    return { exitCode: EXIT_CODE.error };
  }

  const dlOpts: Parameters<typeof downloadAsset>[1] = { userAgent: USER_AGENT };
  if (deps.fetch !== undefined) dlOpts.fetch = fetchFn;
  let downloadedBytes: Uint8Array;
  try {
    downloadedBytes = await downloadAsset(asset.browser_download_url, dlOpts);
  } catch (err) {
    deps.output.error(`download failed: ${(err as Error).message ?? String(err)}`);
    return { exitCode: EXIT_CODE.error };
  }

  if (downloadedBytes.byteLength <= 0) {
    deps.output.error('download verification failed: empty file');
    return { exitCode: EXIT_CODE.error };
  }

  try {
    await replaceBinary(deps.binaryPath, downloadedBytes, platform);
  } catch (err) {
    deps.output.error(
      `failed to install upgrade at ${deps.binaryPath}: ${(err as Error).message ?? String(err)}`,
    );
    return { exitCode: EXIT_CODE.error };
  }

  if (deps.restartDaemon === undefined) {
    deps.output.success(
      `Upgraded from ${deps.currentVersion} to ${latestVersion}; run \`proxai-gateway restart\` to apply.`,
    );
    return { exitCode: EXIT_CODE.ok };
  }

  const restarted = await deps.restartDaemon();
  if (!restarted) {
    deps.output.error(
      `installed ${latestVersion} but could not restart automatically; run \`proxai-gateway restart\` to apply.`,
    );
    return { exitCode: EXIT_CODE.error };
  }

  deps.output.success(`Upgraded from ${deps.currentVersion} to ${latestVersion}.`);
  return { exitCode: EXIT_CODE.ok };
}

function stripV(tag: string): string {
  return tag.startsWith('v') ? tag.slice(1) : tag;
}
