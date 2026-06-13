export type WireType = 0 | 1 | 2 | 5;

export interface FieldVal {
  field: number;
  wire: WireType;
  varint?: bigint;
  fixed64?: bigint;
  fixed32?: number;
  bytes?: Uint8Array;
  str?: string;
  msg?: FieldTree;
}

export type FieldTree = Map<number, FieldVal[]>;

interface ByteReader {
  bytes: Uint8Array;
  pos: number;
}

const MAX_NESTED_DEPTH = 16;

export function scanProto(bytes: Uint8Array): FieldTree {
  const tree: FieldTree = new Map();
  const reader: ByteReader = { bytes, pos: 0 };
  while (reader.pos < bytes.length) {
    const tag = readVarint(reader);
    if (tag === null) break;
    const field = Number(tag >> 3n);
    const wireBits = Number(tag & 7n);
    if (field <= 0) break;
    const value = readField(reader, field, wireBits, MAX_NESTED_DEPTH);
    if (value === null) break;
    appendField(tree, field, value);
  }
  return tree;
}

function readField(
  reader: ByteReader,
  field: number,
  wireBits: number,
  depthBudget: number,
): FieldVal | null {
  if (wireBits === 0) {
    const varint = readVarint(reader);
    if (varint === null) return null;
    return { field, wire: 0, varint };
  }
  if (wireBits === 1) {
    const fixed = readFixed(reader, 8);
    if (fixed === null) return null;
    return { field, wire: 1, fixed64: fixed };
  }
  if (wireBits === 5) {
    const fixed = readFixed(reader, 4);
    if (fixed === null) return null;
    return { field, wire: 5, fixed32: Number(fixed) >>> 0 };
  }
  if (wireBits === 2) {
    return readLengthDelimited(reader, field, depthBudget);
  }
  return null;
}

function readLengthDelimited(
  reader: ByteReader,
  field: number,
  depthBudget: number,
): FieldVal | null {
  const length = readVarint(reader);
  if (length === null) return null;
  const size = Number(length);
  if (size < 0 || reader.pos + size > reader.bytes.length) return null;
  const slice = reader.bytes.subarray(reader.pos, reader.pos + size);
  reader.pos += size;

  const value: FieldVal = { field, wire: 2, bytes: slice };
  const text = tryUtf8(slice);
  if (text !== undefined) {
    value.str = text;
  }
  if (depthBudget > 0) {
    const nested = tryParseMessage(slice, depthBudget - 1);
    if (nested !== undefined) {
      value.msg = nested;
    }
  }
  return value;
}

function readVarint(reader: ByteReader): bigint | null {
  let shift = 0n;
  let value = 0n;
  while (reader.pos < reader.bytes.length && shift < 64n) {
    const byte = reader.bytes[reader.pos];
    if (byte === undefined) return null;
    reader.pos += 1;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return value;
    shift += 7n;
  }
  return null;
}

function readFixed(reader: ByteReader, byteCount: number): bigint | null {
  if (reader.pos + byteCount > reader.bytes.length) return null;
  let value = 0n;
  for (let i = 0; i < byteCount; i += 1) {
    const byte = reader.bytes[reader.pos];
    if (byte === undefined) return null;
    reader.pos += 1;
    value |= BigInt(byte) << BigInt(8 * i);
  }
  return value;
}

function tryParseMessage(bytes: Uint8Array, depthBudget: number): FieldTree | undefined {
  if (bytes.length === 0) return undefined;
  const reader: ByteReader = { bytes, pos: 0 };
  const tree: FieldTree = new Map();
  let fieldsParsed = 0;
  while (reader.pos < bytes.length) {
    const tag = readVarint(reader);
    if (tag === null) return undefined;
    const field = Number(tag >> 3n);
    const wireBits = Number(tag & 7n);
    if (field <= 0) return undefined;
    if (wireBits !== 0 && wireBits !== 1 && wireBits !== 2 && wireBits !== 5) return undefined;
    const value = readField(reader, field, wireBits, depthBudget);
    if (value === null) return undefined;
    appendField(tree, field, value);
    fieldsParsed += 1;
  }
  if (reader.pos !== bytes.length) return undefined;
  if (fieldsParsed === 0) return undefined;
  return tree;
}

function tryUtf8(bytes: Uint8Array): string | undefined {
  if (bytes.length === 0) return undefined;
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  if (hasUnprintableControl(decoded)) return undefined;
  return decoded;
}

function hasUnprintableControl(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code === undefined) continue;
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
    if (code < 0x20) return true;
  }
  return false;
}

function appendField(tree: FieldTree, field: number, value: FieldVal): void {
  const existing = tree.get(field);
  if (existing !== undefined) {
    existing.push(value);
  } else {
    tree.set(field, [value]);
  }
}

export function getPath(tree: FieldTree, dotted: string): FieldVal | undefined {
  const parts = dotted.split('.');
  let current: FieldTree = tree;
  let resolved: FieldVal | undefined;
  for (const part of parts) {
    const fieldNumber = Number(part);
    if (!Number.isInteger(fieldNumber)) return undefined;
    const value = current.get(fieldNumber)?.[0];
    if (value === undefined) return undefined;
    resolved = value;
    if (value.msg === undefined) {
      current = EMPTY_TREE;
    } else {
      current = value.msg;
    }
  }
  return resolved;
}

const EMPTY_TREE: FieldTree = new Map();

export function pStr(tree: FieldTree, dotted: string): string | undefined {
  return getPath(tree, dotted)?.str;
}

export function pNum(tree: FieldTree, dotted: string): number | null {
  const value = getPath(tree, dotted)?.varint;
  return value === undefined ? null : Number(value);
}
