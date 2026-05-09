import { homedir } from 'node:os';
import { join } from 'node:path';

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
  const lines = content.split('\n');
  const out: string[] = [];
  let changed = false;
  let unmatchedMarker = false;
  let i = 0;
  while (i < lines.length) {
    if (lines[i] === MARKER) {
      const next = lines[i + 1];
      if (next !== undefined && next.includes(INSTALL_DIR_HINT)) {
        if (out.length > 0 && out[out.length - 1] === '') {
          out.pop();
        }
        changed = true;
        i += 2;
        continue;
      }
      unmatchedMarker = true;
    }
    out.push(lines[i] ?? '');
    i += 1;
  }
  return { changed, newContent: out.join('\n'), unmatchedMarker };
}

const RC_BASENAMES = ['.zshrc', '.bashrc', '.bash_profile'] as const;

export function createPosixShellPathCleaner(deps: PosixShellPathCleanerDeps): ShellPathCleaner {
  const homeDirResolved = deps.homeDir ?? homedir();
  return {
    clean: async () => {
      const outcomes: PathCleanupOutcome[] = [];
      for (const basename of RC_BASENAMES) {
        const path = join(homeDirResolved, basename);
        let content: string | null;
        try {
          content = await deps.readFile(path);
        } catch (err) {
          outcomes.push({
            path,
            cleaned: false,
            reason: `read failed: ${(err as Error).message ?? String(err)}`,
          });
          continue;
        }
        if (content === null) {
          outcomes.push({ path, cleaned: false, reason: 'file not present' });
          continue;
        }
        const result = stripPathMarkerBlock(content);
        if (!result.changed) {
          outcomes.push({
            path,
            cleaned: false,
            reason: result.unmatchedMarker
              ? 'marker found but next line did not reference our install dir; left untouched'
              : 'no installer marker found',
          });
          continue;
        }
        try {
          await deps.writeFile(path, result.newContent);
          outcomes.push({ path, cleaned: true, reason: 'removed installer PATH block' });
        } catch (err) {
          outcomes.push({
            path,
            cleaned: false,
            reason: `write failed: ${(err as Error).message ?? String(err)}`,
          });
        }
      }
      return outcomes;
    },
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
    stdout: 'pipe',
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
      const env = { ...process.env, PROXAI_INSTALL_DIR: installDir } as Record<string, string>;
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
