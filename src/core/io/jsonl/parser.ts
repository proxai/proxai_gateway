import { JSONL_DECODER, NEWLINE_BYTE } from 'core/io/jsonl/jsonl.constants.ts';
import type { LineResult } from 'core/io/jsonl/jsonl.types.ts';

export function* parseJsonl<T = unknown>(
  bytes: Uint8Array,
  baseOffset = 0,
): Generator<LineResult<T>> {
  let lineStart = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== NEWLINE_BYTE) continue;
    const lineBytes = bytes.subarray(lineStart, i);
    if (lineBytes.length > 0) {
      const rawLine = JSONL_DECODER.decode(lineBytes);
      yield parseLine<T>(rawLine, baseOffset + lineStart);
    }
    lineStart = i + 1;
  }
}

function parseLine<T>(rawLine: string, byteOffset: number): LineResult<T> {
  try {
    const data = JSON.parse(rawLine) as T;
    return { ok: true, data, rawLine, byteOffset };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
      rawLine,
      byteOffset,
    };
  }
}
