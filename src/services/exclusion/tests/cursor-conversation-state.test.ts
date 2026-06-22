// src/services/exclusion/tests/cursor-conversation-state.test.ts
import { describe, expect, it } from 'bun:test';

import { decodeConversationStateHashes } from 'services/exclusion/cursor-conversation-state.ts';

// Build a protobuf with field 1 (wireType 2) entries of the given byte lengths.
function encodeField1(entries: Buffer[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(Buffer.from([0x0a])); // tag: field 1, wireType 2
    parts.push(Buffer.from([e.length])); // length (assumes < 128)
    parts.push(e);
  }
  return Buffer.concat(parts);
}

function conversationState(entries: Buffer[]): string {
  return '~' + encodeField1(entries).toString('base64');
}

describe('decodeConversationStateHashes', () => {
  it('collects field-1 entries that are exactly 32 bytes, in order, as lowercase hex', () => {
    const a = Buffer.alloc(32, 0xab);
    const b = Buffer.alloc(32, 0xcd);
    expect(decodeConversationStateHashes(conversationState([a, b]))).toEqual([
      'ab'.repeat(32),
      'cd'.repeat(32),
    ]);
  });

  it('ignores field-1 entries that are not 32 bytes', () => {
    const short = Buffer.alloc(16, 0x01);
    const ok = Buffer.alloc(32, 0x02);
    expect(decodeConversationStateHashes(conversationState([short, ok]))).toEqual([
      '02'.repeat(32),
    ]);
  });

  it('returns [] for malformed input (missing ~, bad base64, empty)', () => {
    expect(decodeConversationStateHashes('')).toEqual([]);
    expect(decodeConversationStateHashes('no-tilde')).toEqual([]);
    expect(decodeConversationStateHashes('~')).toEqual([]);
    expect(decodeConversationStateHashes('~####')).toEqual([]);
  });

  it('returns [] for non-string input', () => {
    // @ts-expect-error exercising the runtime guard
    expect(decodeConversationStateHashes(null)).toEqual([]);
  });

  // Build a `~`-prefixed conversationState from raw protobuf bytes.
  function cs(raw: Buffer): string {
    return '~' + raw.toString('base64');
  }

  it('skips a VARINT field (wireType 0) then still reads a following 32-byte field-1 hash', () => {
    // field 2, wireType 0 (tag 0x10) carrying varint value 1, then field 1 wireType 2 (0x0a) 32-byte hash.
    const hash = Buffer.alloc(32, 0xab);
    const raw = Buffer.concat([
      Buffer.from([0x10, 0x01]), // field 2, varint = 1 -> exercises WIRE_VARINT skip
      Buffer.from([0x0a, 0x20]), // field 1, length 32
      hash,
    ]);
    expect(decodeConversationStateHashes(cs(raw))).toEqual(['ab'.repeat(32)]);
  });

  it('skips a FIXED64 field (wireType 1) then reads a following field-1 hash', () => {
    const hash = Buffer.alloc(32, 0xcd);
    const raw = Buffer.concat([
      Buffer.from([0x11]), // field 2, wireType 1 (fixed64)
      Buffer.alloc(8, 0x00), // 8 payload bytes
      Buffer.from([0x0a, 0x20]),
      hash,
    ]);
    expect(decodeConversationStateHashes(cs(raw))).toEqual(['cd'.repeat(32)]);
  });

  it('skips a FIXED32 field (wireType 5) then reads a following field-1 hash', () => {
    const hash = Buffer.alloc(32, 0xef);
    const raw = Buffer.concat([
      Buffer.from([0x15]), // field 2, wireType 5 (fixed32)
      Buffer.alloc(4, 0x00), // 4 payload bytes
      Buffer.from([0x0a, 0x20]),
      hash,
    ]);
    expect(decodeConversationStateHashes(cs(raw))).toEqual(['ef'.repeat(32)]);
  });

  it('stops cleanly when a FIXED64 field runs past the buffer end', () => {
    // wireType 1 needs 8 bytes but only 3 remain -> reader.pos > buf.length -> break, no hashes.
    const raw = Buffer.from([0x11, 0x00, 0x00, 0x00]);
    expect(decodeConversationStateHashes(cs(raw))).toEqual([]);
  });

  it('bails on a malformed (>10-byte) varint without throwing', () => {
    // 11 continuation bytes: readVarint hits bytesRead >= 10 -> ok=false -> outer loop breaks.
    const raw = Buffer.alloc(11, 0x80);
    expect(decodeConversationStateHashes(cs(raw))).toEqual([]);
  });

  it('bails when the buffer ends mid-varint (tag continuation with no terminator)', () => {
    // A single 0x80 byte: continuation bit set, buffer ends -> readVarint sets ok=false -> [].
    const raw = Buffer.from([0x80]);
    expect(decodeConversationStateHashes(cs(raw))).toEqual([]);
  });

  it('stops cleanly when a length-delimited field claims more bytes than remain', () => {
    // field 1, wireType 2, declared length 32, but only 4 payload bytes follow:
    // end (2+32) > buf.length -> break, no hash collected.
    const raw = Buffer.concat([Buffer.from([0x0a, 0x20]), Buffer.alloc(4, 0x01)]);
    expect(decodeConversationStateHashes(cs(raw))).toEqual([]);
  });

  it('breaks on an unknown wire type (e.g. wireType 3) without throwing', () => {
    // field 1, wireType 3 (start-group, unsupported) -> falls to the else branch -> break.
    const raw = Buffer.from([0x0b]); // (1 << 3) | 3
    expect(decodeConversationStateHashes(cs(raw))).toEqual([]);
  });
});
