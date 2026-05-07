import type { Database } from 'bun:sqlite';

export function tableExists(db: Database, name: string): boolean {
  const row = db
    .query<
      { name: string },
      [string]
    >("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(name);
  return row != null;
}

export function listTables(db: Database): string[] {
  const rows = db
    .query<
      { name: string },
      []
    >("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all();
  return rows.map((r) => r.name);
}

export function columnExists(db: Database, table: string, column: string): boolean {
  const escaped = table.replace(/"/g, '""');
  const rows = db.query<{ name: string }, []>(`PRAGMA table_info("${escaped}")`).all();
  return rows.some((r) => r.name === column);
}

export function pageCount(db: Database): number {
  const row = db.query<{ page_count: number }, []>('PRAGMA page_count').get();
  return row?.page_count ?? 0;
}

export function maxRowid(db: Database, table: string): number {
  const escaped = table.replace(/"/g, '""');
  try {
    const row = db
      .query<{ max_rowid: number | null }, []>(`SELECT MAX(rowid) AS max_rowid FROM "${escaped}"`)
      .get();
    return row?.max_rowid ?? 0;
  } catch {
    return 0;
  }
}
