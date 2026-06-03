import { homedir } from 'node:os';
import { join } from 'node:path';
import { statFile } from 'core/io/fs';
import { sha256Hex } from 'core/utils';
import {
  CLAUDE_DESKTOP_AUDIT_GLOB_PATTERN,
  CLAUDE_DESKTOP_SESSIONS_DIR,
} from 'sources/claude-desktop/claude-desktop.constants.ts';
import type { DiscoveredClaudeDesktopFile } from 'sources/claude-desktop/claude-desktop.types.ts';

export function claudeDesktopUserDataRoot(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === 'win32') {
    const appData = env['APPDATA'];
    const roaming =
      appData !== undefined && appData.trim().length > 0
        ? appData
        : join(homedir(), 'AppData', 'Roaming');
    return join(roaming, 'Claude');
  }
  if (platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Claude');
  }
  const xdg = env['XDG_CONFIG_HOME'];
  const configHome = xdg !== undefined && xdg.trim().length > 0 ? xdg : join(homedir(), '.config');
  return join(configHome, 'Claude');
}

export function defaultClaudeDesktopSessionsRoot(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(claudeDesktopUserDataRoot(platform, env), CLAUDE_DESKTOP_SESSIONS_DIR);
}

export interface DiscoverClaudeDesktopOptions {
  minimumMtime?: Date | null;
}

export async function discoverClaudeDesktopFiles(
  baseDir: string = defaultClaudeDesktopSessionsRoot(),
  options: DiscoverClaudeDesktopOptions = {},
): Promise<DiscoveredClaudeDesktopFile[]> {
  const found: DiscoveredClaudeDesktopFile[] = [];
  const minMtimeMs = options.minimumMtime?.getTime() ?? null;

  const baseStat = await statFile(baseDir);
  if (!baseStat.exists) return found;

  const glob = new Bun.Glob(CLAUDE_DESKTOP_AUDIT_GLOB_PATTERN);
  for await (const relativePath of glob.scan({ cwd: baseDir, onlyFiles: true })) {
    const sourcePath = join(baseDir, relativePath);
    const stat = await statFile(sourcePath);
    if (!stat.exists) continue;
    if (minMtimeMs !== null && stat.mtimeMs < minMtimeMs) continue;

    found.push({
      sourcePath,
      sourcePathHash: sha256Hex(sourcePath),
      inode: Number(stat.inode),
      sizeBytes: stat.size,
      lastModifiedMs: stat.mtimeMs,
    });
  }

  return found;
}
