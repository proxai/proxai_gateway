---
name: "bun:sqlite Execution Patterns"
description: "Rules for readonly flags, unit-test database mocking, and avoiding node:fs/promises.rm for SQLite databases."
activation: "contextual"
scenarios: ["Opening SQLite files in readonly mode", "Writing unit tests involving database operations", "Cleaning up SQLite database files in test teardowns"]
globs: ["src/**/*.ts", "**/*.ts"]
---

# bun:sqlite rules


- Never use `node:fs/promises.rm` to delete sqlite DBs; use the `rmRecursive` wrapper.
- Use explicit bitwise flags (`SQLITE_OPEN_READONLY | SQLITE_OPEN_URI`) for readonly access; do not default to `?immutable=1` (it disables locking and shared-memory and can read torn data from a live writer). The sole sanctioned use is `openReadOnly(path, { immutable: true })` as the `snapshotSqlite` CANTOPEN fallback for cleanly-closed WAL databases whose `-wal`/`-shm` sidecars are absent (a normal readonly connection opens but fails the first page read with `SQLITE_CANTOPEN`).
- Unit tests must not execute real SQL; use dependency injection.
