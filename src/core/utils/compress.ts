export function zstdCompressSync(data: Uint8Array | string, level = 3): Uint8Array {
  const input = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return Bun.zstdCompressSync(input, { level });
}

export function zstdDecompressSync(data: Uint8Array): Uint8Array {
  return Bun.zstdDecompressSync(data);
}
