# Test rules

- Never assert literal `/` paths; use `node:path.join` or `path.sep` for cross-platform paths.
- Embedded NUL bytes (`\0`) trigger cross-platform invalid-path errors safely.
- Unit tests MUST NOT execute real SQL; use dependency injection.
- Pre-import real modules before calling `mock.module(...)` and restore in `afterEach()`.
- For portable subprocess tests use `bun -e 'script'` instead of `/bin/sh`; resolve binaries with `Bun.which` before `Bun.spawn`.
