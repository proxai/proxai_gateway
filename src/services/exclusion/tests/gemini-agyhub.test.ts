// src/services/exclusion/tests/gemini-agyhub.test.ts
import { describe, expect, it } from 'bun:test';

import { decodeAgyhubFolders } from 'services/exclusion/gemini-agyhub.ts';

// agyhub shape: top field1=repeated entry{ field1=uuid, field2=meta{ field9=repeated root{ field1=fileUri } } }
function lp(field: number, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from([(field << 3) | 2]), Buffer.from([payload.length]), payload]); // len<128 in tests
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
    const m = decodeAgyhubFolders(buf);
    expect(m.get('uuid-nest')).toEqual(['/Users/me/nest']);
    expect(m.get('uuid-multi')).toEqual(['/Users/me/a', '/Users/me/b']);
    expect(m.get('uuid-none')).toEqual([]);
  });
  it('returns an empty map for garbage (never throws)', () => {
    expect(decodeAgyhubFolders(Buffer.from([0xff, 0xff, 0xff])).size).toBe(0);
  });
});
