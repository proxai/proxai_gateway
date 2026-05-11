export interface JsonlRange {
  bytes: Uint8Array;
  endByte: number;
}

export interface ParsedLine<T> {
  ok: true;
  data: T;
  rawLine: string;
  byteOffset: number;
}

export interface ParseFailure {
  ok: false;
  error: Error;
  rawLine: string;
  byteOffset: number;
}

export type LineResult<T> = ParsedLine<T> | ParseFailure;
