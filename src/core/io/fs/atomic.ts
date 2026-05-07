import { randomUUID } from 'node:crypto';
import { rename, unlink } from 'node:fs/promises';

export async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await Bun.write(tmp, data);
  try {
    await rename(tmp, path);
  } catch (err) {
    try {
      await unlink(tmp);
    } catch {
      
    }
    throw err;
  }
}
