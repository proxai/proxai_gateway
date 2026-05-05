import { NEWLINE_BYTE } from 'core/io/jsonl/jsonl.constants.ts';
import type { JsonlRange } from 'core/io/jsonl/jsonl.types.ts';

export async function readJsonlRange(
  path: string,
  start: number,
  end: number,
): Promise<JsonlRange> {
  if (end <= start) {
    return { bytes: new Uint8Array(0), endByte: start, partialTail: new Uint8Array(0) };
  }
  const slice = Bun.file(path).slice(start, end);
  const buf = new Uint8Array(await slice.arrayBuffer());
  const lastNewline = buf.lastIndexOf(NEWLINE_BYTE);
  if (lastNewline < 0) {
    return { bytes: new Uint8Array(0), endByte: start, partialTail: buf };
  }
  const completeLength = lastNewline + 1;
  return {
    bytes: buf.subarray(0, completeLength),
    endByte: start + completeLength,
    partialTail: buf.subarray(completeLength),
  };
}
