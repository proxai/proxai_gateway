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
