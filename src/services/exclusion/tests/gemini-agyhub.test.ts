// src/services/exclusion/tests/gemini-agyhub.test.ts
import { describe, expect, it } from 'bun:test';

import { decodeAgyhubFolders } from 'services/exclusion/gemini-agyhub.ts';

// Encode an unsigned int as a protobuf varint (handles multi-byte tags, e.g. field 17).
function encodeVarint(value: number): Buffer {
  const out: number[] = [];
  let v = value;
  do {
    let byte = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) byte |= 0x80;
    out.push(byte);
  } while (v > 0);
  return Buffer.from(out);
}
// agyhub shape: top field1=repeated entry{ field1=uuid, field2=meta{ field9=repeated root{ field1=fileUri } } }
// Length-delimited (wireType 2) field with a proper varint tag (so fields >15 like 17 encode correctly).
function lp(field: number, payload: Buffer): Buffer {
  return Buffer.concat([encodeVarint((field << 3) | 2), encodeVarint(payload.length), payload]);
}
// A varint-wire (wireType 0) field: tag byte then a single-byte varint value (<128).
function varintField(field: number, value: number): Buffer {
  return Buffer.from([(field << 3) | 0, value]);
}
// A fixed64-wire (wireType 1) field: tag + 8 payload bytes.
function fixed64Field(field: number): Buffer {
  return Buffer.concat([Buffer.from([(field << 3) | 1]), Buffer.alloc(8, 0x00)]);
}
// A fixed32-wire (wireType 5) field: tag + 4 payload bytes.
function fixed32Field(field: number): Buffer {
  return Buffer.concat([Buffer.from([(field << 3) | 5]), Buffer.alloc(4, 0x00)]);
}
const root = (uri: string): Buffer => lp(1, Buffer.from(uri, 'utf8'));
const meta = (uris: string[]): Buffer => Buffer.concat(uris.map((u) => lp(9, root(u))));
const entry = (uuid: string, uris: string[]): Buffer =>
  Buffer.concat([lp(1, Buffer.from(uuid)), lp(2, meta(uris))]);

describe('decodeAgyhubFolders', () => {
  it('maps each conversation UUID to its folder paths (file:// stripped)', () => {
    const buf = Buffer.concat([
      lp(1, entry('uuid-nest', ['file:///Users/me/nest'])),
      lp(1, entry('uuid-multi', ['file:///Users/me/a', 'file:///Users/me/b'])),
      lp(1, entry('uuid-none', [])),
    ]);
    const { folders, complete } = decodeAgyhubFolders(buf);
    expect(folders.get('uuid-nest')).toEqual(['/Users/me/nest']);
    expect(folders.get('uuid-multi')).toEqual(['/Users/me/a', '/Users/me/b']);
    expect(folders.get('uuid-none')).toEqual([]);
    // A well-formed buffer whose top-level walk consumes every byte is complete.
    expect(complete).toBe(true);
  });
  it('returns an empty map for garbage (never throws)', () => {
    expect(decodeAgyhubFolders(Buffer.from([0xff, 0xff, 0xff])).folders.size).toBe(0);
  });
  it('reports complete:true for empty input (no data = nothing to protect)', () => {
    const { folders, complete } = decodeAgyhubFolders(Buffer.alloc(0));
    expect(folders.size).toBe(0);
    expect(complete).toBe(true);
  });
  it('reports complete:false when the buffer is truncated mid-entry', () => {
    const full = Buffer.concat([
      lp(1, entry('uuid-a', ['file:///Users/me/a'])),
      lp(1, entry('uuid-b', ['file:///Users/me/b'])),
    ]);
    // Lop off the tail so the final top-level length-delimited field claims more bytes than remain.
    const truncated = full.subarray(0, full.length - 4);
    const { complete } = decodeAgyhubFolders(truncated);
    expect(complete).toBe(false);
  });

  it('skips top-level non-length-delimited fields (varint/fixed64/fixed32) and still decodes an entry', () => {
    // Interleave varint, fixed64, and fixed32 top-level fields around a real field-1 entry; they
    // must be skipped (advancing pos correctly) while the entry is still mapped, and the walk
    // consumes every byte -> complete:true.
    const buf = Buffer.concat([
      varintField(3, 7), // wt0 skip
      fixed64Field(4), // wt1 skip
      fixed32Field(5), // wt5 skip
      lp(1, entry('uuid-x', ['file:///Users/me/x'])),
    ]);
    const { folders, complete } = decodeAgyhubFolders(buf);
    expect(folders.get('uuid-x')).toEqual(['/Users/me/x']);
    expect(complete).toBe(true);
  });

  it('reports complete:false on an unknown top-level wire type (group, wt3)', () => {
    // field 1, wireType 3 (start-group) is unsupported -> else branch sets ok=false -> not complete.
    const { folders, complete } = decodeAgyhubFolders(Buffer.from([(1 << 3) | 3]));
    expect(folders.size).toBe(0);
    expect(complete).toBe(false);
  });

  it('reports complete:false when a top-level fixed64 field runs past the buffer end', () => {
    // wt1 needs 8 bytes; only 2 remain -> r.pos > length -> ok=false.
    const { complete } = decodeAgyhubFolders(Buffer.from([(2 << 3) | 1, 0x00, 0x00]));
    expect(complete).toBe(false);
  });

  it('reports complete:false when a top-level fixed32 field runs past the buffer end', () => {
    // wt5 needs 4 bytes; only 1 remains -> r.pos > length -> ok=false.
    const { complete } = decodeAgyhubFolders(Buffer.from([(2 << 3) | 5, 0x00]));
    expect(complete).toBe(false);
  });

  it('reports complete:false on a malformed (>10-byte) top-level varint tag', () => {
    // 11 continuation bytes: varint hits n >= 10 -> ok=false -> walk bails -> not complete.
    const { folders, complete } = decodeAgyhubFolders(Buffer.alloc(11, 0x80));
    expect(folders.size).toBe(0);
    expect(complete).toBe(false);
  });

  it('skips non-length-delimited fields INSIDE an entry (fields() varint/fixed64/fixed32 branches)', () => {
    // The entry payload itself carries wt0/wt1/wt5 noise fields before its uuid+meta; fields()
    // must skip them and still surface the uuid->folder mapping.
    const noisyEntry = Buffer.concat([
      varintField(7, 3), // wt0 inside entry
      fixed64Field(8), // wt1 inside entry
      fixed32Field(6), // wt5 inside entry
      lp(1, Buffer.from('uuid-noisy')),
      lp(2, meta(['file:///Users/me/noisy'])),
    ]);
    const { folders } = decodeAgyhubFolders(lp(1, noisyEntry));
    expect(folders.get('uuid-noisy')).toEqual(['/Users/me/noisy']);
  });

  it('stops decoding an entry on an unknown inner wire type (fields() else return)', () => {
    // An entry whose first inner field is wireType 3 (group): fields() returns immediately, so the
    // entry yields no uuid -> no map row. (No throw.)
    const groupEntry = Buffer.from([(1 << 3) | 3]); // inner field 1, wt3
    const { folders, complete } = decodeAgyhubFolders(lp(1, groupEntry));
    expect(folders.size).toBe(0);
    expect(complete).toBe(true); // top-level frame is whole; only the inner walk bailed
  });

  it('falls back to field-17 (primary) when an entry meta has no field-9 roots', () => {
    // meta containing ONLY field 17 (no field 9): roots stays empty, so the field-17 primary path
    // (decodeEntry mf===17) supplies the folder. Exercises the documented defensive fallback.
    const primaryMeta = lp(17, root('file:///Users/me/primary'));
    const entryWithPrimary = Buffer.concat([
      lp(1, Buffer.from('uuid-primary')),
      lp(2, primaryMeta),
    ]);
    const { folders } = decodeAgyhubFolders(lp(1, entryWithPrimary));
    expect(folders.get('uuid-primary')).toEqual(['/Users/me/primary']);
  });

  it('prefers field-9 roots over field-17 primary when both are present', () => {
    // When field 9 yields a root, primary must NOT be used even if field 17 is present.
    const mixedMeta = Buffer.concat([
      lp(9, root('file:///Users/me/real')),
      lp(17, root('file:///Users/me/ignored-primary')),
    ]);
    const e = Buffer.concat([lp(1, Buffer.from('uuid-mixed')), lp(2, mixedMeta)]);
    const { folders } = decodeAgyhubFolders(lp(1, e));
    expect(folders.get('uuid-mixed')).toEqual(['/Users/me/real']);
  });

  it('treats a root whose field is not a file:// URI as no folder (rootFolder returns null)', () => {
    // field 9 root carries field 1 = a non-file URI -> fileUriToPath null -> rootFolder null ->
    // no root pushed. The entry still maps its uuid to an empty folder list.
    const nonFileRoot = lp(1, Buffer.from('vscode-remote://ssh/x', 'utf8'));
    const metaNonFile = lp(9, nonFileRoot);
    const e = Buffer.concat([lp(1, Buffer.from('uuid-nonfile')), lp(2, metaNonFile)]);
    const { folders } = decodeAgyhubFolders(lp(1, e));
    expect(folders.get('uuid-nonfile')).toEqual([]);
  });

  it('rootFolder returns null when the root has neither field 1 nor field 2', () => {
    // field 9 root carries only field 5 (some other field, wt2) -> loop finds no f===1/2 ->
    // returns null -> no root. Exercises the rootFolder fall-through `return null`.
    const otherFieldRoot = lp(5, Buffer.from('whatever', 'utf8'));
    const metaOther = lp(9, otherFieldRoot);
    const e = Buffer.concat([lp(1, Buffer.from('uuid-noroot')), lp(2, metaOther)]);
    const { folders } = decodeAgyhubFolders(lp(1, e));
    expect(folders.get('uuid-noroot')).toEqual([]);
  });
});
