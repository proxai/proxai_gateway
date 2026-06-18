// src/services/exclusion/cursor-conversation-state.ts
//
// Cursor `composerData.conversationState` protobuf decoder.
// A `~`-prefixed standard-base64 protobuf. Field 1 (wireType 2) is the ordered
// list of conversation message blob hashes — each exactly 32 bytes (raw SHA-256);
// their lowercase-hex encodings are the `agentKv:blob:<hex>` row keys.
// Dependency-free wire-format scanner. Bounded defensively; any malformed input
// yields [] rather than throwing. Ported from proxai_nest.

const MAX_PROTOBUF_BYTES = 4 * 1024 * 1024;
const MAX_HASHES = 100_000;

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH_DELIMITED = 2;
const WIRE_FIXED32 = 5;

const SHA256_BYTE_LENGTH = 32;

interface ByteReader {
  buf: Buffer;
  pos: number;
  ok: boolean;
}

function readVarint(reader: ByteReader): number {
  let result = 0;
  let shift = 0;
  let bytesRead = 0;
  while (reader.pos < reader.buf.length) {
    const byte = reader.buf[reader.pos] ?? 0;
    reader.pos += 1;
    bytesRead += 1;
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      return result;
    }
    shift += 7;
    if (bytesRead >= 10) {
      reader.ok = false;
      return 0;
    }
  }
  reader.ok = false;
  return 0;
}

export function decodeConversationStateHashes(conversationState: string): string[] {
  if (typeof conversationState !== 'string') return [];
  if (conversationState.length < 2) return [];
  if (conversationState[0] !== '~') return [];

  const base64Body = conversationState.slice(1);
  const buf = Buffer.from(base64Body, 'base64');
  if (buf.length === 0) return [];
  if (buf.length > MAX_PROTOBUF_BYTES) return [];

  const reader: ByteReader = { buf, pos: 0, ok: true };
  const hashes: string[] = [];

  while (reader.pos < buf.length) {
    const tag = readVarint(reader);
    if (!reader.ok) break;

    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x07;

    if (wireType === WIRE_VARINT) {
      readVarint(reader);
      if (!reader.ok) break;
      continue;
    }
    if (wireType === WIRE_FIXED64) {
      reader.pos += 8;
      if (reader.pos > buf.length) break;
      continue;
    }
    if (wireType === WIRE_FIXED32) {
      reader.pos += 4;
      if (reader.pos > buf.length) break;
      continue;
    }
    if (wireType === WIRE_LENGTH_DELIMITED) {
      const length = readVarint(reader);
      if (!reader.ok) break;
      const start = reader.pos;
      const end = start + length;
      if (length < 0 || end > buf.length) break;
      reader.pos = end;
      if (fieldNumber === 1 && length === SHA256_BYTE_LENGTH) {
        if (hashes.length >= MAX_HASHES) break;
        hashes.push(buf.subarray(start, end).toString('hex'));
      }
      continue;
    }

    break; // unknown wire type
  }

  return hashes;
}
