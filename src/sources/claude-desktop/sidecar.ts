import { join } from 'node:path';

import { statFile } from 'core/io/fs';
import { isRecord } from 'core/utils';
import {
  CLAUDE_DESKTOP_SIDECAR_DIR,
  CLAUDE_DESKTOP_SIDECAR_GLOB_PATTERN,
} from 'sources/claude-desktop/claude-desktop.constants.ts';
import { claudeDesktopUserDataRoot } from 'sources/claude-desktop/discover.ts';

export async function loadDesktopCliSessionIds(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Promise<ReadonlySet<string>> {
  const ids = new Set<string>();
  const base = join(claudeDesktopUserDataRoot(platform, env), CLAUDE_DESKTOP_SIDECAR_DIR);

  const baseStat = await statFile(base);
  if (!baseStat.exists) return ids;

  const glob = new Bun.Glob(CLAUDE_DESKTOP_SIDECAR_GLOB_PATTERN);
  for await (const rel of glob.scan({ cwd: base, onlyFiles: true, dot: true })) {
    try {
      const parsed: unknown = await Bun.file(join(base, rel)).json();
      if (!isRecord(parsed)) continue;
      const cliSessionId = parsed['cliSessionId'];
      if (typeof cliSessionId === 'string' && cliSessionId.length > 0) {
        ids.add(cliSessionId);
      }
    } catch {}
  }
  return ids;
}
