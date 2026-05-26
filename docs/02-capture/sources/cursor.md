[← Back to 2.1 Sources](../2.1-sources.md) · [Index](../../README.md) · [Folder: sources](./README.md)

# Cursor — capture decisions and product selections

> The gateway snapshots Cursor's `cursorDiskKV` sqlite table and ships rows from three key prefixes: `composerData:` (chat headers), `bubbleId:` (per-message envelopes), and `agentKv:blob:` (API-canonical message bodies). Bubble and blob rows are filtered to drop empty / non-conversation records, and every shipped row's value is trimmed before it goes on the wire. The file-snapshot, checkpoint, and inline-diff prefixes are not captured. This page explains what each captured prefix carries, how the filter and trim work, and what the still-skipped prefixes hold.

Cursor's on-disk content is split across many KV prefixes inside a single sqlite database. The gateway captures the three prefixes that together reconstruct a conversation — the chat manifest, the rendered bubbles, and the API-shaped message bodies — and skips the prefixes that only hold file-edit snapshots and inline-diff UI state.

## Where the data lives

| Item | Value |
| --- | --- |
| Base directory (macOS) | `~/Library/Application Support/Cursor/User` (`CURSOR_USER_SUBPATH`) |
| Base directory (Linux) | `~/.config/Cursor/User` (`CURSOR_LINUX_USER_SUBPATH`) |
| Base directory (Windows) | `%APPDATA%\Cursor\User` (`CURSOR_WINDOWS_USER_SUBPATH`) |
| Global DB | `globalStorage/state.vscdb` (`CURSOR_GLOBAL_DB_RELATIVE`) |
| Workspace DB glob | `workspaceStorage/*/state.vscdb` (`CURSOR_WORKSPACE_GLOB`) |
| Source kind | `sqlite_kv_snapshot` |
| Body format | `kv_pairs_json` |
| Watermark kind | `rowid_range` |
| Watermark table required? | No (the `cursorDiskKV` table is implicit) |

The platform branch lives in `defaultCursorUserRoot(platform, env)`; on every host, both the global db and any workspace dbs are discovered.

### Workspaces have no chat data

Cursor's per-workspace `state.vscdb` files exist but **none of them contain a `cursorDiskKV` table** — they hold workspace-scoped VS Code UI state (open tabs, panel positions, etc.). The gateway discovers them via the workspace glob and snapshots them anyway, but the row selection (see below) only returns rows when the table exists. Net effect: workspace dbs contribute zero rows to ingestion on every Cursor install observed so far.

## What gets captured

The SQL the gateway runs against each Cursor sqlite snapshot (`buildCursorSelectRowsSql` in `src/sources/cursor/collect.ts`):

```sql
SELECT rowid, key, CAST(value AS TEXT) AS value
FROM cursorDiskKV
WHERE rowid > ?                              -- the prior watermark
  AND (key LIKE 'composerData:%'
    OR key LIKE 'bubbleId:%'
    OR key LIKE 'agentKv:blob:%')
ORDER BY rowid ASC
```

`agentKv:blob:` values are stored as BLOBs; the `CAST(value AS TEXT)` makes every captured value arrive as a JSON text string regardless of column storage class.

The three captured prefixes:

| Prefix | What it stores |
| --- | --- |
| `composerData:<composerId>` | Per-chat header: `composerId`, model, mode, the ordered bubble manifest (`fullConversationHeadersOnly`), title metadata |
| `bubbleId:<composerId>:<bubbleId>` | One row per chat message envelope (user / assistant / tool / thinking). Carries inline `text`, `thinking.text`, or `toolFormerData` depending on `capabilityType` |
| `agentKv:blob:<sha256>` | Content-addressed message bodies in the canonical "API request" shape (`{role, content, …}`). Linked from bubbles via `conversationState` (see below) |

## Row filtering

`processRows` (`src/sources/cursor/process-rows.ts`) filters the captured rows before any are shipped:

| Prefix | Filter rule |
| --- | --- |
| `composerData:` | Always kept |
| `bubbleId:` | Kept only if the value JSON parses to an object with a non-empty `text` string. Empty-envelope bubbles (thinking-only, tool-only, control markers) are dropped |
| `agentKv:blob:` | Kept only if the value JSON has `role` of `user` or `assistant` (`isAgentKvConversationBlob`). System / tool / other-role blobs are dropped |

## Per-row value trimming

Each kept row's `value` is passed through `trimCursorRowValue` before it is serialised into the batch body:

- **`bubbleId:`** — the value is reduced to the keys `{_v, type, bubbleId, text, richText, createdAt, capabilityType, toolFormerData, thinking, context}`. Every other key is dropped.
- **`agentKv:blob:` with `role: "user"`** — content-array items that are environment-context wrappers are dropped: any item whose `text` (after left-trim) starts with `<user_info>`, `<open_and_recently_viewed_files>`, `<open_files>`, `<recently_viewed_files>`, or `<agent_transcripts>`.
- **`agentKv:blob:` with `role: "assistant"`** — `reasoning` and `redacted-reasoning` content parts are dropped, and inside any `tool-call` part each string argument longer than 512 bytes (UTF-8) is replaced with the literal `"<trimmed>"`.
- **`composerData:`** — the value ships unchanged.

A value that does not parse as a JSON object passes through untouched.

## What gets skipped (and why)

These KV prefixes are **not** included in the row-selection SQL, so they are never read from the snapshot:

| Prefix | What it stores | Why skipped |
| --- | --- | --- |
| `composer.content.<sha256>` | Content-addressed file snapshots referenced by tool-call bubbles (the before/after of `edit_file_v2`) | File-edit bytes, not conversation content |
| `checkpointId:<composerId>:<checkpointId>` | Composer-level snapshot/restore payloads (per-edit overlay file lists) | UI restore state, not message content |
| `ofsContent:<composerId>:<file-uri>` | Per-edit overlay-filesystem content (file snapshots referenced from `inlineDiff`) | File snapshots, not message content |
| `inlineDiff:` | Inline-diff payloads | Inline-diff UI state |
| `codeBlockPartialInlineDiffFates:` | Inline-diff fate tracking | Inline-diff UI state |

The captured set (`composerData:` + filtered `bubbleId:` + filtered `agentKv:blob:`) carries every rendered turn plus the API-canonical message bodies. The skipped set is the file-snapshot, checkpoint, and inline-diff prefixes — these are the largest prefixes by byte volume on a typical install, and they hold edited-file content and diff UI state rather than conversation text. Keeping them out, together with the per-row trimming above, is what keeps Cursor's batch volume manageable despite `cursorDiskKV` being the largest local database of any supported source.

## The bubble ↔ blob linkage

Every user-turn bubble carries a `conversationState` string that begins with `~` followed by base64-encoded protobuf bytes. The decoded protobuf is a list of 32-byte values, each one a SHA-256 hash. Every hash maps directly to an `agentKv:blob:<hex>` key whose value is the corresponding API-formatted message (`{"role": "...", "content": "..."}`).

Verified on two independent chats:

- 3,723-bubble chat: 352 hashes extracted from one user-turn `conversationState`, **352 / 352 (100%)** resolve to `agentKv:blob:` keys.
- 3,193-bubble chat: 406 hashes extracted, **406 / 406 (100%)** resolve.

Bubble values do **not** textually reference `agentKv:blob:` keys (`0` matches of the literal string across all bubble values observed). The link is the protobuf-encoded `conversationState` field, not a string pointer. Because both the bubbles and the blobs they reference are captured, the receiver has the rendered turn and its API-canonical counterpart in the same ingestion stream.

## Are the skipped namespaces lossy?

The skipped prefixes carry file-edit content and UI state, not conversation text. The captured `composerData:` + `bubbleId:` + `agentKv:blob:` set holds the full conversation.

What **is** unique to the skipped `composer.content.<sha>` prefix:

- The before/after **file content** of any `edit_file_v2` tool call. The bubble already has the tool-call envelope (`toolFormerData.name = "edit_file_v2"`, `toolFormerData.params`, `toolFormerData.result.{beforeContentId, afterContentId}`), but the actual file bytes — pre-edit and post-edit — are stored separately as content-addressed entries keyed by SHA-256. The receiver records "an edit happened" with the tool envelope but without the file bytes.

What **is** unique to the other skipped namespaces:

- `checkpointId:` — UI restore points (which files were affected when the user clicked "checkpoint here"). Not message content.
- `ofsContent:` / `inlineDiff:` / `codeBlockPartialInlineDiffFates:` — inline-diff UI state. Not message content.

System prompts and conversation-history compaction summaries live in `agentKv:blob:` rows — these are captured. A system-prompt blob has `role: "system"` and is dropped by the `agentKv:blob:` role filter; compaction summaries arrive as `role: "user"` blobs with a `[Previous conversation summary]: …` prefix and are kept.

## What's inside a captured bubble

The receiver's bubble taxonomy (`proxai_nest/.../cursor/cursor.utils.ts`):

| `type` | `capabilityType` | What the bubble represents | Content field |
| --- | --- | --- | --- |
| `1` | (null) | User turn | `.text` (plain), `.richText` (rich-text JSON), `.context` (selections, attachments) |
| `2` | `null` / `undefined` | Assistant text reply | `.text` |
| `2` | `30` | Assistant thinking / chain-of-thought | `.thinking.text` |
| `2` | `15` | Assistant tool call | `.toolFormerData.{name, params, rawArgs, result, status, tool, toolCallId}` |
| `2` | `22` | Stub / control marker | (rare; carries minimal envelope) |
| `2` | other | Misc UI-level envelope | (preserved verbatim but not projected) |

The `bubbleId:` filter keeps only bubbles with a non-empty `.text`, and the trim step reduces each kept bubble to `{_v, type, bubbleId, text, richText, createdAt, capabilityType, toolFormerData, thinking, context}` — so the fields above are exactly the ones the receiver sees.

`composerData.fullConversationHeadersOnly` is the **ordered** list of bubble IDs with `type` and `grouping.{capabilityType, toolFormerTool, toolCallId}` per entry. The receiver uses this manifest to read bubbles in stream order even when the per-bubble watermarks arrive out of order.

## How the body lands on the wire

| Field | Value |
| --- | --- |
| `body_format` | `kv_pairs_json` |
| `body_compression` | `zstd` (level 3) |
| Body content | JSON array of `{rowid, key, value}` rows after row filtering, per-row value trimming, and redaction. Each `value` is a serialised JSON string. |
| Watermark | `rowid_range`, `(start, end)` over `cursorDiskKV.rowid`. |
| Batch cap | 2 MiB compressed / 10 MiB decompressed. The per-row splitter handles slices whose redacted JSON exceeds the cap by quarantining (one-row metadata in `quarantined_records`, body never retained, cursor advances past the rowid). |

The watermark advances over **all** rows the SELECT returned, including rows the filter dropped — `finalWatermarkEnd` is computed from the last raw rowid, so dropped rows are not re-read on the next poll.

Reads run against a **Bun snapshot** of the live sqlite file (`snapshotSqlite`), so the agent's writer is never blocked and the snapshot sees a consistent point-in-time view. To handle active database writing locks gracefully, the snapshot is opened using a robust double-attempt fallback mechanism:
- **First Attempt**: Opens in standard read-only mode using explicit cross-platform `SQLITE_OPEN_URI | SQLITE_OPEN_READONLY` flags.
- **Second Attempt (Rescue)**: If *any* opening error is thrown (such as `SQLITE_CANTOPEN` or Bun's general `"unable to open database file"`), it immediately retries by appending the `immutable=1` URI query parameter. This instructs SQLite to fully bypass active writes and journal/WAL locks to guarantee safe point-in-time capture without interrupting Cursor. If both attempts fail, the original error is thrown to prevent masking true disk or file issues.


VACUUM detection: `cursorDiskKV` is large enough that Cursor occasionally runs `VACUUM` on its sqlite. The gateway's three signals (file shrank, page count dropped, max rowid regressed) flip the source path to `#gen-N` and start a fresh cursor at rowid 0 after a rebuild, so old watermarks never get reused against the rebuilt database.

## How the receiver parses the body

1. **Receive + validate.** Decompress the body to a `{rows: [{rowid, key, value}, …]}` envelope.
2. **Extract chats.** `CursorExtractChatsService` walks each row, dispatching by `keyKind`:
   - `composerData:<composerId>` → composer header chunk.
   - `bubbleId:<composerId>:<bubbleId>` → bubble chunk.
   - Anything else — including `agentKv:blob:` rows — is not yet recognised by `keyKind`; it increments `agent_gateway_parser_bad_line_total{agent="CURSOR"}` and is dropped. nest does not currently have an `agentKv:blob:` parser path.
   Rows are grouped by `composerId` into `ChatBundle`s. `chatId = composerId`; `agentId` is **always `null`** for Cursor (no native sub-agent record discriminator).
3. **Parse chat.** Within each composer, rows are ordered by `(capture.watermarkStart, rowid)` so the receiver replays in stream order. `composerData.fullConversationHeadersOnly` provides the canonical bubble order; rows arriving across multiple captures still get re-sequenced.
4. **Finalize turn.** `cursor-finalize-turn.service.ts` projects each assistant bubble into a `MessageContent` block:
   - `capabilityType === 30 && thinking.text` → `THINKING` block.
   - `capabilityType === 15 && toolFormerData` → `TOOL` block (the `tool_content` carries the `name`, parsed `args`, `result`, `status`).
   - `capabilityType` null/undefined + non-empty `.text` → `TEXT` block.
   - Anything else: dropped (counter incremented).
   One `agent_call_records` row per turn.

The gateway ships `agentKv:blob:` rows into nest's durable storage, but nest does not yet project them into `agent_call_records` — they currently land as bad-line drops at the extract-chats step. The dashboard renders chats from `composerData:` + `bubbleId:` only; the blob rows are available in nest's raw capture storage for a future parser path.

## Per-source quirks

- **No native sub-agent concept.** `agent_id` is always `null` for Cursor rows. Cursor's "Background Agents" feature appears to run server-side; on this laptop it leaves no observable local KV namespace.
- **Composer-level group counter caps batch fan-out.** `CursorExtractChatsService` emits an `agent_gateway_parser_composers_per_batch_total` metric (observed ~33 composers per batch on cold-boot scans) for downstream observability.
- **Workspace dbs are snapshotted but produce no rows.** Discovery still touches them so a future Cursor version that starts storing chats per-workspace would surface as new captured rows automatically.
- **Schema-version detection reads from the kv rows themselves.** `extractAgentSchemaVersion` walks the captured rows looking for a version-bearing field; falls back to `unknown` if none is present.
- **VACUUM gen-suffix is the cursor's primary defence.** Cursor's table grows monotonically until a VACUUM compacts it; without the gen-suffix logic, a post-VACUUM read would re-emit every row already shipped.

## Skipped-content reality check

Cursor's `cursorDiskKV` is the largest local database of any supported source. The captured set — `composerData:`, filtered `bubbleId:`, and filtered `agentKv:blob:` — carries the chat manifest, every rendered turn, and the API-canonical message bodies (system prompts and compaction summaries included, via the `user`/`assistant` blob roles). The per-row trimming (bubble key whitelist, environment-context wrapper removal, oversized tool-arg truncation) keeps that set from carrying redundant UI scaffolding and bloated tool arguments.

The still-skipped prefixes — `composer.content.*`, `checkpointId:*`, `ofsContent:*`, `inlineDiff:*`, `codeBlockPartialInlineDiffFates:*` — are the file-edit-snapshot and inline-diff UI state. They are not conversation content: the gateway records that an edit happened (via the bubble's `toolFormerData` envelope) without shipping the edited file bytes. These prefixes hold the bulk of `cursorDiskKV`'s byte volume; leaving them out is the single biggest reason Cursor capture stays within the buffer budget.

### The `PROXAI_GATEWAY_CAPTURE_SUB_AGENTS_CURSOR` flag

`buildCursorSelectRowsSql` takes a `captureSubAgents` argument, but the parameter is unused (`_captureSubAgents`) — the prefix list it builds is always the three prefixes `composerData:`, `bubbleId:`, `agentKv:blob:`. The two precomputed SQL variants (`SELECT_ROWS_SQL_BASE` and `SELECT_ROWS_SQL_WITH_SUB_AGENTS`) are therefore identical, and `selectCursorSql` returns the same statement whichever the flag resolves to.

Net effect: **`PROXAI_GATEWAY_CAPTURE_SUB_AGENTS_CURSOR` (and the global `PROXAI_GATEWAY_CAPTURE_SUB_AGENTS`) no longer changes the Cursor captured prefix set.** `agentKv:blob:` is captured by default; the flag does not add `composer.content.*` or any other prefix for Cursor. See [6.4 Maintainer Debug Flags](../../06-operations/6.4-maintainer-debug-flags.md) for the flag's effect on the other sources.

[← Back to 2.1 Sources](../2.1-sources.md) · [Index](../../README.md) · [Folder: sources](./README.md)
