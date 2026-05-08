export function deriveHostId(machineUuid: string, userId: string): string {
  return new Bun.CryptoHasher('sha256')
    .update(`${machineUuid.trim()}:${userId.trim()}`)
    .digest('hex');
}
