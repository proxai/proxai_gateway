import { chmod, mkdir } from 'node:fs/promises';

export async function ensureDir(path: string, mode = 0o700): Promise<void> {
  await mkdir(path, { recursive: true, mode });
  if (process.platform !== 'win32') {
    await chmod(path, mode);
  }
}

export async function setMode(path: string, mode: number): Promise<void> {
  if (process.platform === 'win32') return;
  await chmod(path, mode);
}
