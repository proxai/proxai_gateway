import type { Database } from 'bun:sqlite';

import { getMetadata } from 'services/buffer/metadata.ts';

export function readNumber(db: Database, key: string): number {
  const raw = getMetadata(db, key);
  if (raw === null) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export function readNumberOrNull(db: Database, key: string): number | null {
  const raw = getMetadata(db, key);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function readNumberWithFallback(db: Database, primary: string, legacy: string): number {
  const raw = getMetadata(db, primary);
  if (raw !== null) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return readNumber(db, legacy);
}

export function getMetadataWithFallback(
  db: Database,
  primary: string,
  legacy: string | null,
): string | null {
  const raw = getMetadata(db, primary);
  if (raw !== null) return raw;
  if (legacy === null) return null;
  return getMetadata(db, legacy);
}
