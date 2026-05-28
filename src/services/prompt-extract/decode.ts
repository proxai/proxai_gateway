import { zstdDecompressSync } from 'core/utils';

const DECODER = new TextDecoder('utf-8', { fatal: false });

export function decompressBody(body: Uint8Array): string | null {
  try {
    const decompressed = zstdDecompressSync(body);
    return DECODER.decode(decompressed);
  } catch {
    return null;
  }
}
