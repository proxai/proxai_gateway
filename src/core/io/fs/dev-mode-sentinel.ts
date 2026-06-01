import { existsSync, readFileSync } from 'node:fs';

import { readBootId } from 'core/system/boot-id.ts';
import { isRecord } from 'core/utils/assert.ts';

export async function readDevModeSentinel(
  sentinelPath: string,
  readBootIdFn: () => Promise<string> = readBootId,
): Promise<boolean> {
  if (!existsSync(sentinelPath)) return false;
  try {
    const text = readFileSync(sentinelPath, 'utf8');
    const body: unknown = JSON.parse(text);
    if (!isRecord(body) || typeof body['bootId'] !== 'string') {
      return false;
    }
    const stored = body['bootId'];
    const current = await readBootIdFn();
    return stored === current;
  } catch {
    return false;
  }
}
