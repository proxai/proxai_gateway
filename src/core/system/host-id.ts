import { createHash } from 'node:crypto';

/**
 * Derive a stable per-(machine, user) host identifier.
 *
 * The output is the lowercase hex encoding of `sha256(<machine_uuid>:<user_id>)`,
 * where both inputs are trimmed first to absorb stray whitespace from platform
 * lookups (ioreg / registry / /etc/machine-id) and from the verify-key response.
 *
 * The derivation is deterministic: same machine UUID and same user id always
 * produce the same host id. This is what lets the gateway preserve identity
 * across reinstalls and key rotations on the same machine.
 */
export function deriveHostId(machineUuid: string, userId: string): string {
  return createHash('sha256').update(`${machineUuid.trim()}:${userId.trim()}`).digest('hex');
}
