---
name: "bun:sqlite Execution Patterns"
description: "Rules for readonly flags, unit-test database mocking, and avoiding node:fs/promises.rm for SQLite databases."
activation: "contextual"
scenarios: ["Opening SQLite files in readonly mode", "Writing unit tests involving database operations", "Cleaning up SQLite database files in test teardowns"]
globs: ["src/**/*.ts", "**/*.ts"]
---

# bun:sqlite rules


- Never use `node:fs/promises.rm` to delete sqlite DBs; use the `rmRecursive` wrapper.
- Use explicit bitwise flags (`SQLITE_OPEN_READONLY | SQLITE_OPEN_URI`) for readonly access; do not use `?immutable=1`.
- Unit tests must not execute real SQL; use dependency injection.
