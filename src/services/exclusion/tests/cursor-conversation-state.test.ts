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
});
