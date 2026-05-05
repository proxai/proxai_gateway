import { Database } from 'bun:sqlite';

export function seedTestDatabase(path: string): void {
  const db = new Database(path, { create: true });
  db.run('CREATE TABLE thing (id INTEGER PRIMARY KEY, name TEXT)');
  db.run("INSERT INTO thing (name) VALUES ('a'), ('b'), ('c')");
  db.close();
}
