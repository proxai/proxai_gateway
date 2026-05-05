export function sha256Hex(input: string | Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(input).digest('hex');
}
