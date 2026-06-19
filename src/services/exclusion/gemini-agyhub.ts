import { fileUriToPath } from 'services/exclusion/cursor-folder.ts';

const MAX_BYTES = 8 * 1024 * 1024;
interface R {
  buf: Buffer;
  pos: number;
  ok: boolean;
}
function varint(r: R): number {
  let res = 0;
  let sh = 0;
  let n = 0;
  while (r.pos < r.buf.length) {
    const b = r.buf[r.pos] ?? 0;
    r.pos++;
    n++;
    res += (b & 0x7f) * 2 ** sh;
    if (!(b & 0x80)) return res;
    sh += 7;
    if (n >= 10) {
      r.ok = false;
      return 0;
    }
  }
  r.ok = false;
  return 0;
}
/** Yield (fieldNumber, payloadBytes) for every length-delimited (wiretype 2) field; skip others. */
function* fields(buf: Buffer): Generator<[number, Buffer]> {
  const r: R = { buf, pos: 0, ok: true };
  while (r.pos < buf.length) {
    const tag = varint(r);
    if (!r.ok) return;
    const field = tag >>> 3;
    const wt = tag & 7;
    if (wt === 2) {
      const len = varint(r);
      if (!r.ok) return;
      const start = r.pos;
      const end = start + len;
      if (len < 0 || end > buf.length) return;
      r.pos = end;
      yield [field, buf.subarray(start, end)];
    } else if (wt === 0) {
      varint(r);
      if (!r.ok) return;
    } else if (wt === 1) {
      r.pos += 8;
      if (r.pos > buf.length) return;
    } else if (wt === 5) {
      r.pos += 4;
      if (r.pos > buf.length) return;
    } else return;
  }
}
function rootFolder(rootBytes: Buffer): string | null {
  for (const [f, payload] of fields(rootBytes)) {
    if (f === 1 || f === 2) {
      const p = fileUriToPath(payload.toString('utf8'));
      if (p !== null) return p;
    }
  }
  return null;
}
export function decodeAgyhubFolders(bytes: Buffer): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_BYTES) return map;
  for (const [topField, entry] of fields(bytes)) {
    if (topField !== 1) continue;
    let uuid: string | null = null;
    const folders: string[] = [];
    for (const [f, payload] of fields(entry)) {
      if (f === 1 && uuid === null) uuid = payload.toString('utf8');
      else if (f === 2) {
        const roots: string[] = [];
        let primary: string | null = null;
        for (const [mf, mpayload] of fields(payload)) {
          if (mf === 9) {
            const rt = rootFolder(mpayload);
            if (rt) roots.push(rt);
          } else if (mf === 17 && primary === null) primary = rootFolder(mpayload);
        }
        if (roots.length > 0) folders.push(...roots);
        else if (primary !== null) folders.push(primary);
      }
    }
    if (uuid !== null && uuid.length > 0) {
      const existing = map.get(uuid);
      if (existing) existing.push(...folders);
      else map.set(uuid, folders);
    }
  }
  return map;
}
