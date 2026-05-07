export interface RowidSplitOptions<T> {
  measureCompressed: (rows: readonly T[]) => number;

  targetCompressedBytes: number;
}

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

    const advance = takeCount === 0 ? 1 : takeCount;
    chunks.push(rows.slice(cursor, cursor + advance));
    cursor += advance;
  }

  return chunks;
}

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
