import { expect, test } from 'bun:test';

import { getPath, pNum, pStr, scanProto } from 'sources/gemini/proto-scan.ts';
import {
  concatBytes,
  msgField,
  strField,
  tag,
  varintField,
} from 'sources/gemini/tests/proto-encode.ts';

test('scans varint, string, and nested message fields', () => {
  const message = concatBytes([
    varintField(1, 14),
    strField(2, 'hello world'),
    msgField(5, [varintField(3, 4), strField(20, 'nested-id')]),
  ]);
  const tree = scanProto(message);
  expect(pNum(tree, '1')).toBe(14);
  expect(pStr(tree, '2')).toBe('hello world');
  expect(pNum(tree, '5.3')).toBe(4);
  expect(pStr(tree, '5.20')).toBe('nested-id');
});

test('collects repeated fields as an ordered array', () => {
  const message = concatBytes([strField(7, 'a'), strField(7, 'bb')]);
  const tree = scanProto(message);
  const values = tree.get(7);
  expect(values?.length).toBe(2);
  expect(values?.[0]?.str).toBe('a');
  expect(values?.[1]?.str).toBe('bb');
});

test('decodes deeply nested dotted paths', () => {
  const message = msgField(5, [msgField(4, [strField(2, 'run_command')])]);
  const tree = scanProto(message);
  expect(pStr(tree, '5.4.2')).toBe('run_command');
});

test('returns a partial tree on truncated input without throwing', () => {
  const full = concatBytes([varintField(1, 7), strField(2, 'abcdef')]);
  const truncated = full.subarray(0, full.length - 3);
  expect(() => scanProto(truncated)).not.toThrow();
  const tree = scanProto(truncated);
  expect(pNum(tree, '1')).toBe(7);
  expect(pStr(tree, '2')).toBeUndefined();
});

test('never throws on arbitrary malformed bytes', () => {
  const random = Uint8Array.from([0xff, 0xff, 0xff, 0x07, 0x00, 0x99, 0x12, 0x80, 0x05]);
  expect(() => scanProto(random)).not.toThrow();
});

test('never throws on an empty buffer', () => {
  expect(() => scanProto(new Uint8Array())).not.toThrow();
  expect(scanProto(new Uint8Array()).size).toBe(0);
});

test('getPath and accessors return absent markers for missing paths', () => {
  const tree = scanProto(varintField(1, 1));
  expect(getPath(tree, '5.4.2')).toBeUndefined();
  expect(pStr(tree, '5.4.2')).toBeUndefined();
  expect(pNum(tree, '5.4.2')).toBeNull();
});

test('does not misclassify a plain string field as a nested message', () => {
  const tree = scanProto(strField(2, 'view_file'));
  expect(pStr(tree, '2')).toBe('view_file');
  expect(getPath(tree, '2.1')).toBeUndefined();
});

test('reads fixed32 and fixed64 scalar fields', () => {
  const fixed32 = concatBytes([tag(2, 5), Uint8Array.from([0x04, 0x03, 0x02, 0x01])]);
  const fixed64 = concatBytes([
    tag(3, 1),
    Uint8Array.from([0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01]),
  ]);
  const tree = scanProto(concatBytes([fixed32, fixed64]));
  expect(getPath(tree, '2')?.fixed32).toBe(0x01020304);
  expect(getPath(tree, '3')?.fixed64).toBe(0x0102030405060708n);
});

test('stops scanning when a fixed-width field runs past the buffer end', () => {
  const truncatedFixed64 = concatBytes([tag(3, 1), Uint8Array.from([0x01, 0x02, 0x03])]);
  expect(() => scanProto(truncatedFixed64)).not.toThrow();
  expect(scanProto(truncatedFixed64).size).toBe(0);
});

test('stops scanning when a varint overruns the 64-bit shift budget', () => {
  const overlongVarint = Uint8Array.from([
    0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01,
  ]);
  const message = concatBytes([tag(1, 0), overlongVarint]);
  const tree = scanProto(message);
  expect(tree.size).toBe(0);
});

test('drops a nested field whose value varint overruns the shift budget', () => {
  const overlong = Uint8Array.from([
    0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01,
  ]);
  const inner = concatBytes([tag(3, 0), overlong]);
  const message = msgField(5, [inner]);
  const tree = scanProto(message);
  expect(getPath(tree, '5.3')).toBeUndefined();
});
