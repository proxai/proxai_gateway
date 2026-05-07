import { BODY_TARGET_DECOMPRESSED_BYTES } from 'services/contract';
import type { CaptureConfig } from 'services/config/config.types.ts';

export function resolveMaxDecompressed(capture: CaptureConfig): number {
  return capture.maxDecompressedBytes ?? BODY_TARGET_DECOMPRESSED_BYTES;
}
