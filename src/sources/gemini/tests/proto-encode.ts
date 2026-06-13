export function encodeVarint(value: number | bigint): Uint8Array {
  let remaining = typeof value === 'bigint' ? value : BigInt(value);
  if (remaining < 0n) throw new Error('varint cannot be negative');
  const out: number[] = [];
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining > 0n) byte |= 0x80;
    out.push(byte);
  } while (remaining > 0n);
  return Uint8Array.from(out);
}

export function tag(field: number, wire: number): Uint8Array {
  return encodeVarint((field << 3) | wire);
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function varintField(field: number, value: number | bigint): Uint8Array {
  return concatBytes([tag(field, 0), encodeVarint(value)]);
}

export function bytesField(field: number, payload: Uint8Array): Uint8Array {
  return concatBytes([tag(field, 2), encodeVarint(payload.length), payload]);
}

export function strField(field: number, text: string): Uint8Array {
  return bytesField(field, new TextEncoder().encode(text));
}

export function msgField(field: number, parts: readonly Uint8Array[]): Uint8Array {
  return bytesField(field, concatBytes(parts));
}
