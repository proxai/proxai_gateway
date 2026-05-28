import { mkdir, writeFile, readdir, stat, unlink, symlink, copyFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

export async function writeFileAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, content);
  await Bun.write(path, await Bun.file(tmpPath).text());
  await unlink(tmpPath).catch(() => {});
}

export function hashOf(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/**
 * Recursively copy `src` to `dst`. Returns list of relative file paths copied.
 */
export async function copyDirRecursive(src: string, dst: string): Promise<string[]> {
  const out: string[] = [];
  await mkdir(dst, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const sp = join(src, e.name);
    const dp = join(dst, e.name);
    if (e.isDirectory()) {
      const sub = await copyDirRecursive(sp, dp);
      out.push(...sub.map((s) => join(e.name, s)));
    } else if (e.isFile()) {
      await mkdir(dirname(dp), { recursive: true });
      await copyFile(sp, dp);
      out.push(e.name);
    }
  }
  return out;
}

export type LinkMode = 'symlink' | 'copy';

export async function symlinkOrCopy(
  srcOrTarget: string,
  destPath: string,
  mode: LinkMode,
): Promise<void> {
  await mkdir(dirname(destPath), { recursive: true });
  try {
    await unlink(destPath);
  } catch {
    /* ignore if not found */
  }
  if (mode === 'symlink') {
    await symlink(srcOrTarget, destPath);
  } else {
    await copyFile(srcOrTarget, destPath);
  }
}

export async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function safeDelete(p: string): Promise<void> {
  try {
    await unlink(p);
  } catch {
    /* ignore */
  }
}
