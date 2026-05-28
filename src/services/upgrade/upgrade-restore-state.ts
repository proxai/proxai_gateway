import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { writeAtomic } from 'core/io/fs/atomic.ts';
import { isRecord } from 'core/utils/assert.ts';

export const UPGRADE_RESTORE_STATE_FILE = '.upgrade-restore-state';

export interface UpgradeRestoreState {
  readonly devWasRunning: boolean;
}

export function readUpgradeRestoreState(rootDir: string): UpgradeRestoreState | null {
  const path = join(rootDir, UPGRADE_RESTORE_STATE_FILE);
  if (!existsSync(path)) return null;
  try {
    const body: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isRecord(body) || typeof body['devWasRunning'] !== 'boolean') return null;
    return { devWasRunning: body['devWasRunning'] };
  } catch {
    return null;
  }
}

export async function writeUpgradeRestoreState(
  rootDir: string,
  state: UpgradeRestoreState,
): Promise<void> {
  await writeAtomic(join(rootDir, UPGRADE_RESTORE_STATE_FILE), JSON.stringify(state));
}

export function deleteUpgradeRestoreState(rootDir: string): void {
  rmSync(join(rootDir, UPGRADE_RESTORE_STATE_FILE), { force: true });
}
