import { expect, test } from 'bun:test';
import { BODY_TARGET_DECOMPRESSED_BYTES } from 'services/contract';
import type { CaptureConfig } from 'services/config/config.types.ts';
import { resolveMaxDecompressed } from 'services/config/resolve.ts';
import { TEST_CAPTURE_CONFIG } from './test-config.ts';

test('resolveMaxDecompressed returns maxDecompressedBytes when explicitly specified', () => {
  const capture: CaptureConfig = {
    ...TEST_CAPTURE_CONFIG,
    maxDecompressedBytes: 12345,
  };
  const result = resolveMaxDecompressed(capture);
  expect(result).toBe(12345);
});

test('resolveMaxDecompressed falls back to BODY_TARGET_DECOMPRESSED_BYTES when maxDecompressedBytes is undefined', () => {
  const capture: CaptureConfig = {
    ...TEST_CAPTURE_CONFIG,
  };
  delete (capture as { maxDecompressedBytes?: unknown }).maxDecompressedBytes;
  const result = resolveMaxDecompressed(capture);
  expect(result).toBe(BODY_TARGET_DECOMPRESSED_BYTES);
});

test('resolveMaxDecompressed falls back to BODY_TARGET_DECOMPRESSED_BYTES when maxDecompressedBytes is omitted', () => {
  const capture: CaptureConfig = {
    ...TEST_CAPTURE_CONFIG,
  };
  const result = resolveMaxDecompressed(capture);
  expect(result).toBe(BODY_TARGET_DECOMPRESSED_BYTES);
});
