import { createHash } from 'node:crypto';

export function deriveHostId(machineUuid: string, userId: string): string {
  return createHash('sha256').update(`${machineUuid.trim()}:${userId.trim()}`).digest('hex');
}
