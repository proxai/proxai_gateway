import { rmdir, unlink } from 'node:fs/promises';

export interface BinaryRemovalResult {
  ok: boolean;
  deferred: boolean;
  message: string;
}

export interface BinaryRemovalOptions {
  installDir?: string;
}

export interface DirectBinaryRemover {
  remove(execPath: string, options?: BinaryRemovalOptions): Promise<BinaryRemovalResult>;
}

export interface PosixBinaryRemoverDeps {
  unlinkImpl?: (path: string) => Promise<void>;
  rmdirImpl?: (path: string) => Promise<void>;
}

export function createPosixBinaryRemover(deps: PosixBinaryRemoverDeps = {}): DirectBinaryRemover {
  const unlinkImpl = deps.unlinkImpl ?? unlink;
  const rmdirImpl = deps.rmdirImpl ?? rmdir;
  return {
    remove: async (execPath, options = {}) => {
      let removed = false;
      try {
        await unlinkImpl(execPath);
        removed = true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          return {
            ok: false,
            deferred: false,
            message: `failed to remove binary at ${execPath}: ${(err as Error).message ?? String(err)}`,
          };
        }
      }
      if (options.installDir !== undefined) {
        try {
          await rmdirImpl(options.installDir);
        } catch {
          // dir not empty or not present — leave it alone
        }
      }
      return {
        ok: true,
        deferred: false,
        message: removed ? `removed ${execPath}` : `binary already gone: ${execPath}`,
      };
    },
  };
}

export type DetachedSpawn = (file: string, args: string[]) => void;

export interface WindowsBinaryRemoverDeps {
  spawnImpl?: DetachedSpawn;
}

export const realDetachedSpawn: DetachedSpawn = (file, args) => {
  Bun.spawn([file, ...args], {
    stdout: 'ignore',
    stderr: 'ignore',
    stdin: 'ignore',
  });
};

export function createWindowsBinaryRemover(
  deps: WindowsBinaryRemoverDeps = {},
): DirectBinaryRemover {
  const spawn = deps.spawnImpl ?? realDetachedSpawn;
  return {
    remove: async (execPath, options = {}) => {
      const installDirFragment =
        options.installDir !== undefined ? ` & rmdir "${options.installDir}" 2>nul` : '';
      const cmd =
        `ping -n 3 127.0.0.1 >nul & del /F /Q "${execPath}"` +
        ` & if exist "${execPath}.new" del /F /Q "${execPath}.new"` +
        installDirFragment;
      try {
        spawn('cmd.exe', ['/c', cmd]);
      } catch (err) {
        return {
          ok: false,
          deferred: false,
          message: `failed to schedule binary removal: ${(err as Error).message ?? String(err)}`,
        };
      }
      return {
        ok: true,
        deferred: true,
        message: `scheduled removal of ${execPath} on exit`,
      };
    },
  };
}

export function createDefaultBinaryRemover(
  platform: NodeJS.Platform = process.platform,
): DirectBinaryRemover {
  if (platform === 'win32') return createWindowsBinaryRemover();
  return createPosixBinaryRemover();
}
