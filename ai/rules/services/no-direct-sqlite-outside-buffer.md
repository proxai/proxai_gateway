---
name: "Buffer DB Access Restrictions"
description: "Restricts bun:sqlite imports and direct SQL operations on buffer.db to code under src/services/buffer/."
activation: "contextual"
scenarios: ["Executing SQL updates against buffer tables", "Performing migrations or changing table schema", "Initializing SQLite instances or typing buffer parameters"]
globs: ["src/**/*.ts", "**/*.ts"]
---

# Buffer DB Access Rule


**Only code under `src/services/buffer/` may import `bun:sqlite` to
touch `buffer.db`. Every other module goes through the buffer API
(`services/buffer/index.ts` re-exports).**

This is the single-writer chokepoint that keeps buffer schema changes
local, makes the `0o600` mode + WAL + `synchronous = NORMAL` pragma set
auditable in one place, and lets unit tests mock the buffer cleanly via
dependency injection.

## What "goes through the API" means

Allowed in any module:

```ts
import { insertBatch, setCursor, getMetadata } from 'services/buffer';
```

Disallowed in any module outside `services/buffer/`:

```ts
import { Database } from 'bun:sqlite';
const db = new Database(bufferPath);
db.run('UPDATE upload_batches SET ...');
```

## Specifically prohibited

- Importing `Database` from `bun:sqlite` outside `services/buffer/`
  except to receive a `Database` instance as a typed parameter (e.g.
  `runDrainCycle(ctx: { buffer: Database; ... })`). Receiving the
  handle is fine; opening one is not.
- Re-implementing any UPSERT, DELETE, or SELECT against
  `upload_batches`, `source_cursors`, `upload_receipts`,
  `buffer_metadata`, `daemon_state`, or `quarantined_records`.
- Touching `buffer.db` from a CLI command without going through the
  buffer API. The CLI passes the opened `Database` through to
  `services/buffer/*` functions.

## Why

1. **Schema migration is additive-only and has no down-migrations**.
   `migrateCursorVacuumColumns` (`buffer/db.ts:52-59`) is the canonical
   pattern: check `columnExists`, run `ALTER TABLE ... ADD COLUMN` if
   absent. If schema knowledge leaks outside `buffer/`, additive
   migrations can silently mis-align with consumer code's assumed
   columns.
2. **Pragma set is fixed**: `WAL`, `synchronous = NORMAL`,
   `foreign_keys = ON`. Re-opening the same DB from outside
   `buffer/db.ts:openBufferDb` skips these and produces a different
   isolation contract.
3. **Transactions are bounded**: `markBatchDelivered`, `pruneBuffer`,
   capture-cycle worker commit each wrap their writes in
   `db.transaction(...)`. Ad-hoc SQL outside `buffer/` would not nest
   correctly with these transactions.
4. **Test isolation**: unit tests use `openInMemoryBufferDb()` and
   inject the resulting handle. Callers that import `Database` directly
   cannot be unit-tested without real filesystem state.

## Source paths sqlite

A separate concern: **source** sqlite files (Cursor `state.vscdb`,
Codex `state_*.sqlite`) are opened read-only via
`src/core/io/sqlite/open.ts` and `snapshotSqlite`. Those paths *do*
import `bun:sqlite` outside `buffer/` — that's fine because they never
touch `buffer.db`. The rule is specifically about `buffer.db`.

## Enforcement

Rule violations are caught by code review; there is no automated
linter. The `services/buffer/index.ts` barrel re-exports every public
function, so a `grep -rn "from 'bun:sqlite'" src/` outside `core/io/`
and `services/buffer/` is the audit query.

[source: src/services/buffer/db.ts, src/services/buffer/index.ts, src/services/buffer/buffer.constants.ts, .claude/rules/services/buffer-schema.md, .claude/rules/services/bun-sqlite.md]
