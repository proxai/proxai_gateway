export type InstallSource = 'brew' | 'install-script' | 'npm' | 'manual';

export type AutoUpgradePhase =
  | 'idle'
  | 'checking_install_source'
  | 'brew_branch'
  | 'in_place_branch'
  | 'done';

export interface AutoUpgradeInput {
  readonly installSource: InstallSource;
  readonly currentVersion: string;
  readonly binaryPath: string | null;
  readonly updateAvailableSentinelPath: string | null;
}

export interface AutoUpgradeContext {
  readonly installSource: InstallSource;
  readonly currentVersion: string;
  readonly binaryPath: string | null;
  readonly updateAvailableSentinelPath: string | null;
  latestVersion: string | null;
  assetUrl: string | null;
  downloadedBytes: number | null;
  lastError: string | null;
  exitedAt: string | null;
}

export type AutoUpgradeEvent =
  | { type: 'START' }
  | { type: 'VERSION_OK_UPDATE_AVAILABLE'; latestVersion: string; assetUrl: string | null }
  | { type: 'VERSION_OK_NO_UPDATE'; latestVersion: string }
  | { type: 'VERSION_NO_RELEASE'; reason: string }
  | { type: 'VERSION_ERROR'; reason: string }
  | { type: 'ASSET_RESOLVED'; assetUrl: string }
  | { type: 'ASSET_NOT_FOUND' }
  | { type: 'DOWNLOAD_OK'; bytes: number }
  | { type: 'DOWNLOAD_EMPTY' }
  | { type: 'BINARY_REPLACED' }
  | { type: 'EXIT'; exitedAtUtc: string };
