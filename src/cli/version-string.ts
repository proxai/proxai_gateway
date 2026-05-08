import { readFileSync } from 'node:fs';

import type { InstallSource } from 'services/config';

export type VersionInstallSource = InstallSource | 'unknown';

export function formatVersionString(version: string, installSource: VersionInstallSource): string {
  return `proxai-gateway ${version}\ninstalled via ${installSource}`;
}

export function readInstallSourceSync(configPath: string): VersionInstallSource {
  let text: string;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch {
    return 'unknown';
  }
  return parseInstallSourceFromToml(text);
}

export function parseInstallSourceFromToml(toml: string): VersionInstallSource {
  const match = /install_source\s*=\s*"([a-z0-9_]+)"/i.exec(toml);
  if (match === null || match[1] === undefined) return 'unknown';
  const v = match[1];
  if (
    v === 'bun' ||
    v === 'pnpm' ||
    v === 'yarn' ||
    v === 'npm' ||
    v === 'brew' ||
    v === 'github_release'
  ) {
    return v;
  }
  return 'unknown';
}
