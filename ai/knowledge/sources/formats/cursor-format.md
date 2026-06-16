# cursor File Format

Cursor stores agent session data inside VS Code-style sqlite databases:

- `globalStorage/state.vscdb` — one global DB per Cursor install.
- `workspaceStorage/<hash>/state.vscdb` — one DB per workspace.

Both share the same on-disk shape.

## SQLite layout

The table of interest is `cursorDiskKV(key TEXT, value BLOB)`. There is no
per-row metadata column; the agent payload is encoded entirely in the JSON
value, and the key prefix identifies the row category.

VS Code's own `ItemTable` table coexists in the same file — the parser is
scoped strictly to `cursorDiskKV` and ignores everything else.

## Key prefixes (`CURSOR_KEY_PREFIX_*`)

| Key prefix              | What the value contains                                              | Captured? |
| ----------------------- | -------------------------------------------------------------------- | --------- |
| `composerData:<id>`     | Composer (agent session) header / metadata; carries `_v` schema flag | yes       |
| `bubbleId:<id>`         | One user/assistant "bubble" within a composer; carries `_v`, `text`, `richText`, etc. | yes |
| `agentKv:blob:<id>`     | Newer-schema agent message blobs; carries `role`, `content[]`        | yes       |
| `composer.content.<id>` | Defined in constants, **not** in SELECT — reserved                   | no        |

The SQL filter (`buildCursorSelectRowsSql`, collect.ts:22) is:

```sql
SELECT rowid, key, CAST(value AS TEXT) AS value
FROM cursorDiskKV
WHERE rowid > ?
  AND (
    key LIKE 'composerData:%' OR
    key LIKE 'bubbleId:%' OR
    key LIKE 'agentKv:blob:%'
  )
ORDER BY rowid ASC
```

`CAST(value AS TEXT)` is load-bearing — values are stored as BLOB but treated as
UTF-8 JSON by the parser.

## Value shapes

### `composerData:<id>`

JSON object representing a composer header. The parser uses:

- `_v` (number or string) — composer schema version, surfaced in
  `agentSchemaVersion` as the prefix.

Other fields (timestamps, model, options) pass through unfiltered.

### `bubbleId:<id>`

JSON object representing one bubble. The parser:

- **Drops** the row if `parsed.text` is missing or empty (after trim).
- **Trims** the value to exactly these fields:
  `_v, type, bubbleId, text, richText, createdAt, capabilityType,
  toolFormerData, thinking, context`.

Anything outside the allow-list is removed before redaction. `_v` surfaces in
`agentSchemaVersion` as the second component (`composer:bubble`).

### `agentKv:blob:<id>`

JSON object with `role` and `content`:

- **Drops** the row if `role` is not `'user'` or `'assistant'`
  (`isAgentKvConversationBlob`, process-rows.ts:36).
- **Trims** `content[]` per role:
  - `role === 'user'`: filter out items whose `text` starts with any of
    `<user_info>`, `<open_and_recently_viewed_files>`, `<open_files>`,
    `<recently_viewed_files>`, `<agent_transcripts>` — these are IDE-context
    blobs auto-prepended by Cursor.
  - `role === 'assistant'`: drop items whose `type ∈ {reasoning,
    redacted-reasoning}` (chain-of-thought never ships); for `type === 'tool-call'`,
    redact `args` values that are strings > 512 bytes to `'<trimmed>'`.

## Version contract

`extractAgentSchemaVersion` (extract-version.ts:8) returns
`"<composerVersion>:<bubbleVersion>"`, falling back to `'unknown'` if both are missing (or `<composerVersion>:unknown` / `unknown:<bubbleVersion>` if only one is missing). The composer and
bubble schemas evolve independently in Cursor, so the dual form lets the server
detect skew on either side.

## VACUUM and identity

`state.vscdb` files are subject to vacuum/rotation by VS Code's storage layer.
The parser:

- Always reads via `snapshotSqlite` (a Bun snapshot to a temp file) so the live
  writer is never blocked.
- Tracks `lastSeenSizeBytes` and `lastSeenPageCount` on every cursor write.
- On the next poll, runs `detectVacuum` against the snapshot's current size,
  page count, and `maxRowid(db, 'cursorDiskKV')`. Any of `size_decreased`,
  `page_count_decreased`, `rowid_regressed` triggers a re-key:
  `nextGenerationSuffix(path)` adds `#gen-N`, the `sourcePathHash` is
  recomputed, and the cursor is treated as absent so capture restarts.

## Inode handling

`sourceInode` is always `null` for cursor. VS Code may unlink and re-create the
vscdb file (especially during settings sync), which would change the inode
without changing the logical content. Path-hash + VACUUM detection is the
identity contract; inode would introduce spurious cursor splits.

## Encoding

- `value` is BLOB on disk but always UTF-8 text in practice. Non-UTF-8 bytes
  would survive the `CAST AS TEXT` and end up JSON-escaped at body-serialize
  time.
- The body envelope is `{ rows: [{ rowid, key, value }, ...] }`. This wrapper
  is cursor-specific (codex state has no wrapper).

[source: src/sources/cursor/cursor.constants.ts:14-21; src/sources/cursor/collect.ts:22-44; src/sources/cursor/process-rows.ts:36-164; src/sources/cursor/process-rows.ts:352-365; src/sources/cursor/extract-version.ts:8-40]
