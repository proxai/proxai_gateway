import { NEWLINE_BYTE } from 'core/io/jsonl/jsonl.constants.ts';

export interface JsonlSplitOptions {
  /** Compresses a slice and returns the compressed byteLength. */
  measureCompressed: (bytes: Uint8Array) => number;
  /** Maximum compressed byte length any single slice may have. */
  targetCompressedBytes: number;
}

/**
 * Splits a JSONL byte buffer into chunks at `\n` boundaries such that each
 * chunk, when compressed via `measureCompressed`, is at most
 * `targetCompressedBytes` bytes.
 *
 * The input MUST end with a newline byte — callers strip trailing partial
 * lines before invoking this helper. If the whole buffer already fits the
 * threshold, a single-element array containing the original buffer is
 * returned.
 *
 * Algorithm: for each remaining suffix, binary-search the largest prefix
 * ending at a `\n` whose compressed size is within budget. If even the
 * smallest prefix (one line) exceeds the threshold, that single line is
 * emitted as its own chunk — the contract validator will reject it and the
 * uploader will mark the batch failed, but that is preferable to silently
 * dropping an unbounded byte range.
 *
 * Throws when `bytes` does not end at a newline (caller bug — held-back
 * partial lines must be excluded before calling).
 */
export function splitJsonlAtBoundary(bytes: Uint8Array, options: JsonlSplitOptions): Uint8Array[] {
  if (bytes.byteLength === 0) return [];
  if (bytes[bytes.byteLength - 1] !== NEWLINE_BYTE) {
    throw new Error('splitJsonlAtBoundary requires input to end at a newline');
  }

  // Whole-buffer fast path: avoid a full compress when the caller has already
  // measured size or when the slice is trivially small.
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

/**
 * Binary-searches the byte range `[start, end)` (which is known to end at a
 * `\n`) for the largest prefix that:
 *   - ends at a `\n`,
 *   - and whose compressed size is `<= targetCompressedBytes`.
 *
 * Returns an absolute byte offset inside `bytes`. The minimum return value is
 * the offset just past the FIRST newline in the range — even when that single
 * line already exceeds the budget, the caller still gets a slice that ends at
 * a line boundary (the caller is responsible for handling the over-budget
 * outcome upstream).
 */
function findLargestPrefixEndingAtNewline(
  bytes: Uint8Array,
  start: number,
  end: number,
  measureCompressed: (bytes: Uint8Array) => number,
  targetCompressedBytes: number,
): number {
  // Locate the first newline — guaranteed to exist because end-1 is a \n.
  const firstNewline = indexOfNewline(bytes, start, end);
  // first valid split (after the first complete line)
  const minSplit = firstNewline + 1;
  // last valid split is the full range (always at \n by invariant)
  let lo = minSplit;
  let hi = end;
  let best = minSplit;

  // Binary search by byte midpoint, then snap to the nearest \n boundary
  // that still lies inside [minSplit, hi].
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const snapped = snapToNewline(bytes, start, end, mid);
    if (snapped < minSplit) {
      lo = mid + 1;
      continue;
    }
    if (snapped > hi) {
      hi = mid - 1;
      continue;
    }
    const candidate = bytes.subarray(start, snapped);
    const size = measureCompressed(candidate);
    if (size <= targetCompressedBytes) {
      best = snapped;
      lo = snapped + 1;
    } else {
      hi = snapped - 1;
    }
  }

  return best;
}

function indexOfNewline(bytes: Uint8Array, from: number, to: number): number {
  for (let i = from; i < to; i++) {
    if (bytes[i] === NEWLINE_BYTE) return i;
  }
  return -1;
}

/**
 * Returns the byte offset of the first `\n` boundary at or after `position`
 * within `[start, end)`, expressed as the index immediately AFTER that
 * newline (i.e. a valid prefix-end). Falls back to `end` (the guaranteed
 * trailing newline boundary) when no earlier newline exists.
 */
function snapToNewline(bytes: Uint8Array, start: number, end: number, position: number): number {
  const clamped = Math.max(start, Math.min(end, position));
  for (let i = clamped; i < end; i++) {
    if (bytes[i] === NEWLINE_BYTE) return i + 1;
  }
  return end;
}
