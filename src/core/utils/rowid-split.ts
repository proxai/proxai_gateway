export interface RowidSplitOptions<T> {
  /** Compresses a row slice and returns the compressed byteLength. */
  measureCompressed: (rows: readonly T[]) => number;
  /** Maximum compressed byte length any single slice may have. */
  targetCompressedBytes: number;
}

/**
 * Splits an ordered row array into contiguous slices such that each slice,
 * when serialized + compressed via `measureCompressed`, is at most
 * `targetCompressedBytes` bytes.
 *
 * Returns one or more non-empty subarrays whose concatenation equals the
 * input. If a SINGLE row already exceeds the threshold, that row is emitted
 * as its own slice — the contract validator will reject it and the uploader
 * will mark the batch failed, but that is preferable to silently dropping
 * unbounded source rows.
 */
export function splitRowsByCompressedSize<T>(
  rows: readonly T[],
  options: RowidSplitOptions<T>,
): readonly T[][] {
  if (rows.length === 0) return [];
  if (options.targetCompressedBytes <= 0) {
    throw new Error('targetCompressedBytes must be positive');
  }

  const chunks: T[][] = [];
  let cursor = 0;
  const total = rows.length;

  while (cursor < total) {
    const remaining = rows.slice(cursor, total);
    const remainingSize = options.measureCompressed(remaining);
    if (remainingSize <= options.targetCompressedBytes) {
      chunks.push(remaining);
      cursor = total;
      break;
    }

    const takeCount = findLargestPrefixCount(
      rows,
      cursor,
      total,
      options.measureCompressed,
      options.targetCompressedBytes,
    );
    // Always make forward progress: if no prefix fits (single-row overflow),
    // emit one row anyway so the caller surfaces a hard failure rather than
    // looping forever.
    const advance = takeCount === 0 ? 1 : takeCount;
    chunks.push(rows.slice(cursor, cursor + advance));
    cursor += advance;
  }

  return chunks;
}

/**
 * Binary-searches `[start+1, end]` for the largest prefix length whose
 * compressed size is `<= targetCompressedBytes`. Returns 0 when even a
 * single-row prefix already exceeds the budget (caller handles).
 */
function findLargestPrefixCount<T>(
  rows: readonly T[],
  start: number,
  end: number,
  measureCompressed: (rows: readonly T[]) => number,
  targetCompressedBytes: number,
): number {
  let lo = 1;
  let hi = end - start;
  let best = 0;

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const candidate = rows.slice(start, start + mid);
    const size = measureCompressed(candidate);
    if (size <= targetCompressedBytes) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return best;
}
