import type { InstallSource } from 'services/config/config.types.ts';

const DEFAULT_FALLBACK: InstallSource = 'github_release';

export function inferInstallSource(
  execPath: string,
  _platform: NodeJS.Platform = process.platform,
): InstallSource {
  const norm = execPath.replace(/\\/g, '/').toLowerCase();
  if (norm.includes('/.proxai/bin/')) return 'github_release';
  if (norm.includes('/cellar/') || norm.includes('/linuxbrew/')) return 'brew';
  if (norm.includes('/.bun/install/global/')) return 'bun';
  if (norm.includes('/pnpm/') || norm.includes('/.pnpm/')) return 'pnpm';
  if (norm.includes('/.yarn/') || norm.includes('/yarn/global/')) return 'yarn';
  if (norm.includes('node_modules/@proxai/')) return 'npm';
  return DEFAULT_FALLBACK;
}
