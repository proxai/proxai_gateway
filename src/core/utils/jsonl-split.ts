import { NEWLINE_BYTE } from 'core/io/jsonl/jsonl.constants.ts';

export interface JsonlSplitOptions {
  measureCompressed: (bytes: Uint8Array) => number;
  targetCompressedBytes: number;
}

export function splitJsonlAtBoundary(bytes: Uint8Array, options: JsonlSplitOptions): Uint8Array[] {
  if (bytes.byteLength === 0) return [];
  if (bytes[bytes.byteLength - 1] !== NEWLINE_BYTE) {
    throw new Error('splitJsonlAtBoundary requires input to end at a newline');
  }
  if (options.targetCompressedBytes <= 0) {
    throw new Error('targetCompressedBytes must be positive');
  }

  const chunks: Uint8Array[] = [];
  let cursor = 0;
  const total = bytes.byteLength;

  while (cursor < total) {
    const remaining = bytes.subarray(cursor, total);
    const wholeRemainingSize = options.measureCompressed(remaining);
    if (wholeRemainingSize <= options.targetCompressedBytes) {
      chunks.push(remaining);
      cursor = total;
      break;
    }

    const splitAt = findLargestPrefixEndingAtNewline(
      bytes,
      cursor,
      total,
      options.measureCompressed,
      options.targetCompressedBytes,
    );

    chunks.push(bytes.subarray(cursor, splitAt));
    cursor = splitAt;
  }

  return chunks;
}

function findLargestPrefixEndingAtNewline(
  bytes: Uint8Array,
  start: number,
  end: number,
  measureCompressed: (bytes: Uint8Array) => number,
  targetCompressedBytes: number,
): number {
  const splits: number[] = [];
  for (let i = start; i < end; i++) {
    if (bytes[i] === NEWLINE_BYTE) splits.push(i + 1);
  }

  let best = splits[0]!;
  let lo = 0;
  let hi = splits.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const splitAt = splits[mid]!;
    const candidate = bytes.subarray(start, splitAt);
    if (measureCompressed(candidate) <= targetCompressedBytes) {
      best = splitAt;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}
