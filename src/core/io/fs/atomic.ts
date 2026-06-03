import { randomUUID } from 'node:crypto';
import { chmod, rename, unlink } from 'node:fs/promises';

export async function writeAtomic(
  path: string,
  data: string | Uint8Array,
  mode?: number,
): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await Bun.write(tmp, data);
  if (mode !== undefined && process.platform !== 'win32') {
    try {
      await chmod(tmp, mode);
    } catch {}
  }
  try {
    await rename(tmp, path);
  } catch (err) {
    try {
      await unlink(tmp);
    } catch {}
    throw err;
  }
}
