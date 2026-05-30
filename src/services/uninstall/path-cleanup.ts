import { homedir } from 'node:os';
import { join } from 'node:path';

import { stripMarkerBlock } from 'core/utils';

const MARKER = '# Added by ProxAI Gateway installer';
const INSTALL_DIR_HINT = '.proxai/bin';

export interface PathCleanupOutcome {
  path: string;
  cleaned: boolean;
  reason: string;
}

export interface ShellPathCleaner {
  clean(installDir: string): Promise<PathCleanupOutcome[]>;
}

export interface PosixShellPathCleanerDeps {
  homeDir?: string;
  readFile: (path: string) => Promise<string | null>;
  writeFile: (path: string, content: string) => Promise<void>;
}

export function stripPathMarkerBlock(content: string): {
  changed: boolean;
  newContent: string;
  unmatchedMarker: boolean;
} {
  return stripMarkerBlock(content, {
    marker: MARKER,
    followingLineSubstring: INSTALL_DIR_HINT,
  });
}

const RC_BASENAMES = ['.zshrc', '.bashrc', '.bash_profile'] as const;

export function createPosixShellPathCleaner(deps: PosixShellPathCleanerDeps): ShellPathCleaner {
  const homeDirResolved = deps.homeDir ?? homedir();
  return {
    clean: async () =>
      Promise.all(
        RC_BASENAMES.map(async (basename): Promise<PathCleanupOutcome> => {
          const path = join(homeDirResolved, basename);
          let content: string | null;
          try {
            content = await deps.readFile(path);
          } catch (err) {
            return {
              path,
              cleaned: false,
              reason: `read failed: ${(err as Error).message ?? String(err)}`,
            };
          }
          if (content === null) {
            return { path, cleaned: false, reason: 'file not present' };
          }
          const result = stripPathMarkerBlock(content);
          if (!result.changed) {
            return {
              path,
              cleaned: false,
              reason: result.unmatchedMarker
                ? 'marker found but next line did not reference our install dir; left untouched'
                : 'no installer marker found',
            };
          }
          try {
            await deps.writeFile(path, result.newContent);
            return { path, cleaned: true, reason: 'removed installer PATH block' };
          } catch (err) {
            return {
              path,
              cleaned: false,
              reason: `write failed: ${(err as Error).message ?? String(err)}`,
            };
          }
        }),
      ),
  };
}

export type SpawnPathCleaner = (
  file: string,
  args: string[],
  env: Record<string, string>,
) => Promise<{ ok: boolean; stderr: string }>;

export interface WindowsShellPathCleanerDeps {
  spawnImpl?: SpawnPathCleaner;
}

const POWERSHELL_SCRIPT =
  `$d = $env:PROXAI_INSTALL_DIR; ` +
  `if (-not $d) { exit 0 } ; ` +
  `$cur = [Environment]::GetEnvironmentVariable('PATH', 'User'); ` +
  `if (-not $cur) { exit 0 } ; ` +
  `$entries = $cur -split ';' | Where-Object { $_ -and $_.TrimEnd('\\') -ne $d.TrimEnd('\\') } ; ` +
  `[Environment]::SetEnvironmentVariable('PATH', ($entries -join ';'), 'User')`;

export const realPowershellSpawn: SpawnPathCleaner = async (file, args, env) => {
  const proc = Bun.spawn([file, ...args], {
    stdout: 'ignore',
    stderr: 'pipe',
    stdin: 'ignore',
    env,
  });

  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  return { ok: proc.exitCode === 0, stderr };
};

export function createWindowsShellPathCleaner(
  deps: WindowsShellPathCleanerDeps = {},
): ShellPathCleaner {
  const spawn = deps.spawnImpl ?? realPowershellSpawn;
  return {
    clean: async (installDir: string) => {
      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        PROXAI_INSTALL_DIR: installDir,
      };
      try {
        const { ok, stderr } = await spawn(
          'powershell.exe',
          ['-NoProfile', '-Command', POWERSHELL_SCRIPT],
          env,
        );
        if (ok) {
          return [
            {
              path: 'User PATH (Windows registry)',
              cleaned: true,
              reason: 'removed installer entry from User PATH',
            },
          ];
        }
        return [
          {
            path: 'User PATH (Windows registry)',
            cleaned: false,
            reason: `powershell exited non-zero: ${stderr.trim().split('\n').slice(-1)[0] ?? 'unknown'}`,
          },
        ];
      } catch (err) {
        return [
          {
            path: 'User PATH (Windows registry)',
            cleaned: false,
            reason: `powershell spawn failed: ${(err as Error).message ?? String(err)}`,
          },
        ];
      }
    },
  };
}

export function createDefaultShellPathCleaner(
  platform: NodeJS.Platform = process.platform,
  homeDirOverride?: string,
): ShellPathCleaner {
  if (platform === 'win32') return createWindowsShellPathCleaner();
  const deps: PosixShellPathCleanerDeps = {
    readFile: async (path) => {
      const file = Bun.file(path);
      if (!(await file.exists())) return null;
      return file.text();
    },
    writeFile: async (path, content) => {
      await Bun.write(path, content);
    },
  };
  if (homeDirOverride !== undefined) deps.homeDir = homeDirOverride;
  return createPosixShellPathCleaner(deps);
}
