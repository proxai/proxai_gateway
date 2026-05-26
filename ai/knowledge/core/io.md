# Core I/O

`src/core/io/` is split into three sub-modules (`fs`, `jsonl`, `sqlite`) re-exported as namespaces from `src/core/io/index.ts`. They are the lowest layer that touches the disk; everything above them goes through these helpers rather than calling `node:fs` / `bun:sqlite` directly.

## `core/io/fs/`

| Helper | Signature | Notes |
| --- | --- | --- |
| `writeAtomic(path, data)` | `(string, string \| Uint8Array) → Promise<void>` | `Bun.write(path.uuid.tmp, data)` then `rename`; unlinks tmp on rename failure (`atomic.ts:4`) |
| `ensureDir(path, mode = 0o700)` | `(string, number?) → Promise<void>` | `mkdir({ recursive: true, mode })` + post-mkdir `chmod` on POSIX (`mode.ts:3`) |
| `setMode(path, mode)` | `(string, number) → Promise<void>` | no-op on Windows; `chmod` elsewhere (`mode.ts:10`) |
| `statFile(path)` | `(string) → Promise<StatResult>` | bigint stat with `ENOENT → { exists: false }` (`stat.ts:5`) |
| `rmRecursive(path, opts?)` | `(string, RmRecursiveOptions?) → Promise<void>` | Windows-aware retry loop, see below (`rm-recursive.ts:25`) |
| `sentinelHandle(path)` | `(string) → SentinelHandle` | `exists`/`read`/`write`/`remove` for sentinel files (`sentinel.ts:7`) |
| `expandHome(path)` | `(string) → string` | resolves `~`, `~/...`, `~\...` (`paths.ts:88`) |
| path helpers | — | `configDir`, `logDir`, `bufferDbPath`, `configFilePath`, all sentinel paths, `controlSocketPath` (`paths.ts`) |

Constants: `ORG_NAME = 'proxai'`, `APP_NAME = 'proxai-gateway'` (`fs.constants.ts:1`).

Types: `FileStat`, `MissingStat`, `StatResult`, `SentinelHandle` (`fs.types.ts`).

### Atomic write contract

`writeAtomic` is the only writer used for any file the daemon cares about (config, sentinels, service-unit files, scheduled-task XML). Two guarantees:

1. **Crash safety.** A power loss between `Bun.write` and `rename` leaves the tmp file behind (collected on next reboot or by `uninstall --reset`) but never a half-written final file.
2. **Reader atomicity.** `rename` is atomic on POSIX and (with the same volume) on NTFS. Readers always see either the previous content or the new content, never both.

The tmp suffix is `.<randomUUID>.tmp` — never a fixed name — so concurrent writers don't clobber each other's tmp files (though we don't actually have concurrent writers for any one path; the UUID guards against bugs).

### `rmRecursive` Windows retry

`node:fs/promises.rm(path, { recursive: true, force: true })` is unreliable on Windows when sqlite has just released a `buffer.db` handle: the OS reports `EBUSY` for tens to hundreds of milliseconds. `rmRecursive` wraps `nodeRm` and on Windows retries up to 10 times when the error code is `EBUSY` / `ENOTEMPTY` / `EPERM`, sleeping `baseDelayMs * (attempt+1)` between attempts (`rm-recursive.ts:37`). It also calls `Bun.gc(true)` between retries to encourage the GC to drop any lingering FinalizationRegistry-tracked handles. All retries are guarded by `isWindows`; POSIX users see exactly one attempt.

Tests must use this wrapper rather than `node:fs.rm` for sqlite teardown — see `ai/rules/modules/cross-platform.md`.

### `sentinelHandle`

A four-method object (`exists`, `read`, `write`, `remove`) for a single path:

- `exists` — `Bun.file(path).exists()`.
- `read` — empty string if missing; full body otherwise.
- `write(body)` — `writeAtomic` + `setMode(path, 0o600)`.
- `remove` — `unlink`, swallows `ENOENT`.

All sentinel writes go through this handle. See `ai/rules/services/sentinels.md` for the gate-vs-content contract.

## `core/io/jsonl/`

Streaming JSONL parser plus a "read up to last complete line" range helper.

| Helper | Signature | Notes |
| --- | --- | --- |
| `readJsonlRange(path, start, end)` | `(string, number, number) → Promise<JsonlRange>` | Reads `[start, end)` from `path`, trims to the last `\n` (`reader.ts:4`). Returns empty range if no newline in slice. |
| `parseJsonl<T>(bytes, baseOffset = 0)` | `(Uint8Array, number?) → Generator<LineResult<T>>` | Splits on `0x0a`, yields `{ ok, data, rawLine, byteOffset }` per non-empty line (`parser.ts:4`). Failure becomes `{ ok: false, error }`. |

Constants: `NEWLINE_BYTE = 0x0a`, `JSONL_DECODER = TextDecoder('utf-8', { fatal: false })` (`jsonl.constants.ts`).

Both helpers are used by every JSONL-backed source (Claude Code, Codex rollouts, Gemini CLI). The byte-offset is the absolute file offset of the line start (`baseOffset + lineStart`), which sources use to advance their watermark to "end of last complete line".

## `core/io/sqlite/`

Read/write helpers and snapshot capture for sqlite sources.

| Helper | Signature | Notes |
| --- | --- | --- |
| `openReadOnly(path, opts?)` | `(string, { immutable?: boolean }) → Database` | `immutable=true` switches to URI mode with `SQLITE_OPEN_READONLY | SQLITE_OPEN_URI` (`open.ts:10`) |
| `openReadWrite(path)` | `(string) → Database` | `create: true`, sets WAL + `synchronous=NORMAL` + `foreign_keys=ON`, chmods 0o600 on POSIX (`open.ts:19`) |
| `snapshotSqlite(sourcePath, opts?)` | `(string, SnapshotSqliteOptions?) → Promise<Snapshot>` | Opens read-only, `VACUUM INTO '<tmp>'`, returns `{ path, cleanup }` (`snapshot.ts:17`) |
| `tableExists(db, name)` | `(Database, string) → boolean` | `sqlite_master` lookup (`introspect.ts:3`) |
| `listTables(db)` | `(Database) → string[]` | Excludes `sqlite_%` system tables (`introspect.ts:13`) |
| `columnExists(db, table, column)` | `(Database, string, string) → boolean` | `PRAGMA table_info` (`introspect.ts:23`) |
| `pageCount(db)` | `(Database) → number` | `PRAGMA page_count` (`introspect.ts:29`) |
| `maxRowid(db, table)` | `(Database, string) → number` | `SELECT MAX(rowid)`; returns 0 on any error (`introspect.ts:34`) |

### Snapshot fallback

`snapshotSqlite` deliberately uses a two-stage open (`open(path)` → on failure `open(path, { immutable: true })`) via `openWithCantopenFallback`. The fallback exists because Codex's `state_*.sqlite` is sometimes locked with `SQLITE_CANTOPEN` when the agent is actively writing; the URI `?immutable=1` form lets us VACUUM-INTO a snapshot without needing the WAL. The fallback always re-throws the first error if the second attempt also fails — so callers always see the most specific failure.

### Identifier escaping in `introspect`

`columnExists` and `maxRowid` template the table name into a `"..."`-quoted identifier with `table.replace(/"/g, '""')` to handle double-quotes in table names. Use these helpers rather than building your own DDL string.

[source: src/core/io/fs/atomic.ts:4; src/core/io/fs/mode.ts:3,10; src/core/io/fs/sentinel.ts:7; src/core/io/fs/rm-recursive.ts:25,37; src/core/io/fs/paths.ts:6,22,40,44,77,88; src/core/io/fs/fs.constants.ts:1; src/core/io/fs/stat.ts:5; src/core/io/jsonl/reader.ts:4; src/core/io/jsonl/parser.ts:4; src/core/io/jsonl/jsonl.constants.ts:1; src/core/io/sqlite/open.ts:10,19; src/core/io/sqlite/snapshot.ts:17,37; src/core/io/sqlite/introspect.ts:3,13,23,29,34]
