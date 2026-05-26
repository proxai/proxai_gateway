---
name: audit-sqlite-usage
description: Audit all bun:sqlite call sites for correctness against the rules in bun-sqlite.md and cross-platform.md.
---

# Audit SQLite Usage

## When to use

Use when touching any file under `src/core/io/sqlite/` or any source collector that opens a sqlite DB; when fixing sqlite-related test failures on Windows.

## Key files

- `src/core/io/sqlite/open.ts`
- `src/core/io/fs/rm-recursive.ts`
- `src/services/buffer/db.ts`
- `src/sources/cursor/`
- `src/sources/codex/`

## Common pitfalls

- Using `?immutable=1` URI flag (works on macOS, fails on Linux/Windows); use `SQLITE_OPEN_READONLY | SQLITE_OPEN_URI` flags explicitly.
- Using `node:fs/promises.rm` for teardown on Windows (EBUSY); use `rmRecursive` instead.
- Forgetting to extend `afterEach` timeout to 30 s for tests that open sqlite.
- Executing real SQL in unit tests — all sqlite tests must use dependency injection.
- Missing the double-attempt open pattern for source databases (try `openReadOnly`, fallback to `{ immutable: true }` on any error).
