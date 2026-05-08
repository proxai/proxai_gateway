import { rm as nodeRm } from 'node:fs/promises';

const RETRYABLE_WINDOWS_CODES = new Set(['EBUSY', 'ENOTEMPTY', 'EPERM']);
const MAX_ATTEMPTS = 10;
const DEFAULT_BASE_DELAY_MS = 250;

export interface RmRecursiveOptions {
  attempts?: number;
  baseDelayMs?: number;
  isWindows?: boolean;
  delay?: (ms: number) => Promise<void>;
  rm?: (path: string) => Promise<void>;
}

interface ResolvedConfig {
  attempts: number;
  baseDelayMs: number;
  isWindows: boolean;
  delay: (ms: number) => Promise<void>;
  rm: (path: string) => Promise<void>;
}

export async function rmRecursive(path: string, options: RmRecursiveOptions = {}): Promise<void> {
  const cfg: ResolvedConfig = {
    attempts: options.attempts ?? MAX_ATTEMPTS,
    baseDelayMs: options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
    isWindows: options.isWindows ?? process.platform === 'win32',
    delay: options.delay ?? defaultDelay,
    rm: options.rm ?? defaultRm,
  };
  await attemptRm(path, 0, cfg);
}

async function attemptRm(path: string, attempt: number, cfg: ResolvedConfig): Promise<void> {
  try {
    await cfg.rm(path);
  } catch (err) {
    const isLast = attempt === cfg.attempts - 1;
    if (!cfg.isWindows || isLast) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === undefined || !RETRYABLE_WINDOWS_CODES.has(code)) throw err;
    await cfg.delay(cfg.baseDelayMs * (attempt + 1));
    await attemptRm(path, attempt + 1, cfg);
  }
}

function defaultRm(path: string): Promise<void> {
  return nodeRm(path, { recursive: true, force: true });
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
