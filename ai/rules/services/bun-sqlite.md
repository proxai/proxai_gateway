# bun:sqlite rules

- Never use `node:fs/promises.rm` to delete sqlite DBs; use the `rmRecursive` wrapper.
- Use explicit bitwise flags (`SQLITE_OPEN_READONLY | SQLITE_OPEN_URI`) for readonly access; do not use `?immutable=1`.
- Unit tests must not execute real SQL; use dependency injection.
