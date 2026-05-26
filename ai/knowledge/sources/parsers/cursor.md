# cursor Parser

Captures Cursor IDE agent transcripts from the editor's VS Code-style sqlite
key-value stores (`state.vscdb`). Source kind is `sqlite_kv_snapshot` — the parser
reads via a Bun snapshot so the live editor writer is never blocked.

## Files watched

- Base dir (`defaultCursorUserRoot`, discover.ts:15) branches on platform:
  - macOS (`darwin`): `~/Library/Application Support/Cursor/User`
  - linux: `$HOME/.config/Cursor/User`
  - win32: `%APPDATA%/Cursor/User`, falling back to
    `<homedir>/AppData/Roaming/Cursor/User`
- Two discovery targets:
  - `globalStorage/state.vscdb` (single file)
  - `workspaceStorage/*/state.vscdb` (one per workspace, pinned-depth glob)

## Discovery (`discoverCursorFiles`, discover.ts:38)

1. `statFile(baseDir)` early-return.
2. `tryDescribe` the global DB; push if it exists and passes mtime filter.
3. Walk `workspaceStorage/*/state.vscdb` with `Bun.Glob`; push each that exists
   and passes the mtime filter.

Each entry: `{ sourcePath, sourcePathHash (sha256), inode, sizeBytes,
lastModifiedMs }`.

## Capture format (input)

SQLite with table `cursorDiskKV(key TEXT, value BLOB)`. Cursor stores agent
session data under three key prefixes (`CURSOR_DISK_KV_TABLE` allow-list in
`collect.ts:22`):

| Key prefix          | Purpose                                                  |
| ------------------- | -------------------------------------------------------- |
| `composerData:`     | Composer (agent) session header / metadata               |
| `bubbleId:`         | Individual user/assistant "bubbles" within a composer    |
| `agentKv:blob:`     | Agent message blobs (newer schema; role=user/assistant)  |

The fourth prefix `composer.content.` is defined in constants but not in the
collector's SELECT — it's reserved for future use. Format details in
`ai/knowledge/sources/formats/cursor-format.md`.

## Collection (`collectCursorFile`, collect.ts:51)

1. `snapshotSqlite(file.sourcePath)` → temp copy. Cleanup awaited in `finally`.
2. `openReadOnly(snapshot.path)` and check `tableExists(db, 'cursorDiskKV')`.
   Missing table = empty result (some workspace DBs have no agent data).
3. VACUUM detection: pull `pageCount(db)`, `maxRowid(db, table)`, fresh
   `sourceStat.size`, compare with the prior cursor via `detectVacuum`. If
   vacuumed, re-key via `nextGenerationSuffix(path)` (appends `#gen-N`) and a
   fresh `sourcePathHash`; treat cursor as absent.
4. `SELECT rowid, key, CAST(value AS TEXT) AS value FROM cursorDiskKV WHERE rowid
   > ? AND (key LIKE 'composerData:%' OR key LIKE 'bubbleId:%' OR key LIKE
   'agentKv:blob:%') ORDER BY rowid ASC` with `lastMaxRowid = watermarkEnd - 1`.
5. `extractAgentSchemaVersion(rows)` (extract-version.ts:8) walks the rows once,
   pulling `_v` from the first `composerData:` and first `bubbleId:` row, and
   returns `${composerVersion ?? 'unknown'}:${bubbleVersion ?? 'unknown'}`.
6. `processRows` (process-rows.ts:166) filters and trims per row, then slices.

### Row-level filtering (`processRows`)

- `bubbleId:*`: dropped unless `parsed.text` is a non-empty string after trim.
- `agentKv:blob:*`: dropped unless `isAgentKvConversationBlob` accepts (parsed
  object whose `role` is `user` or `assistant`).
- `composerData:*`: passed through unfiltered (header metadata).

### Row-level trimming (`trimCursorRowValue`, process-rows.ts:141)

- `bubbleId:*`: keep only `_v, type, bubbleId, text, richText, createdAt,
  capabilityType, toolFormerData, thinking, context`. Strip everything else.
- `agentKv:blob:*` with `role=user`: filter out content parts whose `text`
  starts with `<user_info>`, `<open_and_recently_viewed_files>`, `<open_files>`,
  `<recently_viewed_files>`, or `<agent_transcripts>` (IDE-context noise).
- `agentKv:blob:*` with `role=assistant`: drop content parts whose `type ∈
  {reasoning, redacted-reasoning}`; for `type=tool-call`, redact any arg value
  string > 512 bytes to `'<trimmed>'`.

## Output `NewBatch`

- `sourceApp: 'cursor'`
- `sourceKind: 'sqlite_kv_snapshot'`
- `bodyFormat: 'kv_pairs_json'`
- `watermarkKind: 'rowid_range'`
- `watermarkTable: null` (one logical stream per file)
- `sourceInode: null` (cursor uses path-hash only — sqlite snapshot decouples
  inode from logical identity)
- `agentSchemaVersion`: `<composerVersion>:<bubbleVersion>`, e.g.
  `"3:14"`, falling back to `'unknown:unknown'`.
- Body: `zstd(redact(JSON.stringify({ rows: slice })))` (the body envelope is
  `{ rows: [...] }`).

## Parser version scheme

No parser-internal version. `agentSchemaVersion` is the dual `_v` field that
Cursor embeds in each row payload. The dual form lets the server detect skew
between composer and bubble schemas independently.

## Redaction integration

Per-slice `createSliceMeasurer` (process-rows.ts:352) caches
`{ redactedJson, rawBytes, compressed }` keyed on the slice array via `WeakMap`.
The splitter uses both byte counts to find the largest prefix that fits the
2 MiB compressed / 10 MiB decompressed budget. If a slice still exceeds 10 MiB
after redaction, `recordQuarantine` writes a metadata-only quarantine row and
the cursor advances past it — progress is never blocked.

## Watermark handling

- Cursor key: `(sourceApp='cursor', sourcePathHash, sourceInode=null, table=null)`.
- Initial watermark: `1` (rowid space; `lastMaxRowid = 1 - 1 = 0`, so all rows
  with `rowid > 0` are read).
- After capture: `watermarkEnd = lastRow.rowid + 1`, plus
  `lastSeenSizeBytes` and `lastSeenPageCount` for VACUUM detection on the next
  poll.
- Empty-result path still updates `lastSeenSizeBytes` / `lastSeenPageCount` (and
  resets `consecutiveErrors`) so vacuum detection stays accurate during quiet
  periods.

## Dedup

- rowid is monotonic in `cursorDiskKV`; the watermark guarantees no row is
  re-read.
- VACUUM re-key (`#gen-N` suffix) restarts at rowid 0 against a fresh
  `sourcePathHash`, so the server treats post-vacuum data as a new source rather
  than as duplicate rowids overwriting prior ones.
- Server: `capture_id` UUIDv7 idempotency key.

## Idle-flush behavior

Poll-driven only (120 s capture cycle). No "session ended" hook; Cursor doesn't
emit one. Newly-written rows surface on the next poll.

## Error path

Outer `try/catch/finally`:

1. Catch records `{ sourcePath, reason }`, then best-effort reads the prior
   cursor and bumps `consecutiveErrors`, preserving `lastSeenSizeBytes` and
   `lastSeenPageCount` if present.
2. `finally` runs `snapshot.cleanup()` unconditionally to drop the temp DB copy.

Per-row quarantines push to `result.errors` but do not abort the poll — they
advance the cursor past the offending row and continue.

## Gotchas

- The SQL builder `buildCursorSelectRowsSql` accepts `_captureSubAgents` but
  currently returns the same query for both. The sub-agent flag is plumbed
  through but has no effect on Cursor at present.
- `value` is stored as BLOB but cast to TEXT at SELECT time. Non-UTF-8 bytes
  would survive the cast intact; redaction operates on the JSON-stringified
  form so binary trash in any field becomes a JSON-escaped string.
- `sourceInode` is always null for Cursor — vscdb files get rotated/replaced and
  inode tracking would produce spurious cursor splits. Path-hash + VACUUM
  detection is the identity contract.
- `composer.content.` prefix is defined but not selected. Adding it requires
  updating both `buildCursorSelectRowsSql` and `processRows` filtering rules.

[source: src/sources/cursor/cursor.constants.ts:1-22; src/sources/cursor/discover.ts:15-77; src/sources/cursor/collect.ts:22-196; src/sources/cursor/process-rows.ts:36-366; src/sources/cursor/extract-version.ts:8-40]
