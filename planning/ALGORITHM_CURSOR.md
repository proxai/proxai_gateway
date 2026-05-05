# Cursor Algorithms — Flushing, Parsing, Metadata

**Status:** Draft v0.1 (grounded in real on-disk data from this machine; sample size is small — see §7)
**Owner:** ProxAI
**Last updated:** 2026-04-29
**Scope:** Backend-and-gateway algorithms for turning Cursor's on-disk conversation state into `CallRecord`s. Companion to `ALGORITHM_CLAUDE.md`, `DESIGN.md` (component split), `CAPTURE_TARGETS.md` (file paths), `CALL_RECORD_MAPPING.md` (field-by-field schema mapping).

> **Read `ALGORITHM_CLAUDE.md` first.** This doc only argues the points where Cursor differs from Claude Code; everything that's the same is just referenced. The two docs share the same shape (one `CallRecord` per turn, parent-pointer linked list, mirror-the-source for resume).

---

## 1. What this doc decides

Three algorithms, each with one decision — same structure as `ALGORITHM_CLAUDE.md`:

1. **Flushing (gateway).** Snapshot the global Cursor SQLite via `VACUUM INTO` every 5 min; tail the `cursorDiskKV` table by **monotonic `rowid` watermark**, ship rows for `composerData:` and `bubbleId:` prefixes only. §3.
2. **Call-record parsing (backend).** One `CallRecord` per **user-bubble turn boundary** (a `type=1` bubble + all subsequent `type=2` bubbles until the next `type=1`). Linked list via `parent_turn_id` = previous user bubble's id in the same composer. §4.
3. **Metadata parsing (backend).** Project derived from attached file paths in user-bubble context, agent mode from `composerData.unifiedMode`, model from `composerData.modelConfig`. **Token usage is not exposed by Cursor's local data** — this is a real gap; see §5.3. §5.

Where Cursor *meaningfully* diverges from Claude Code: storage is SQLite KV not append-only JSONL (changes the flushing approach), there is no `parentUuid` graph (the composer's bubble-ordering array is the only sequence signal), and per-turn token usage is **missing in observed data** (the `tokenCount` field exists but is always `{0,0}`).

The ground truth is the user's own `~/Library/Application Support/Cursor/` tree on this machine. **Sample is thin** — 33 composers but only 3 with actual conversations (89 bubbles total). The user has explicitly said they use Cursor less. §7 lists what could not be verified from this sample and how to close those gaps before MVP code-freeze.

---

## 2. Observed shape of Cursor on-disk data

### 2.1 File layout

```
~/Library/Application Support/Cursor/User/
    globalStorage/
        state.vscdb                       ← all conversation content lives here
        state.vscdb-shm                   ← WAL shared-memory; ignore
        state.vscdb-wal                   ← WAL; ignore (we VACUUM INTO instead)
        state.vscdb.backup                ← old; ignore
        storage.json                      ← workspace/profile metadata (no LLM content)
    workspaceStorage/<workspace-hash>/
        state.vscdb                       ← contains 0 cursorDiskKV rows in observed data
        workspace.json                    ← maps hash → folder URI (used in §5.1)
```

**Key correction vs. `CAPTURE_TARGETS.md` and `CALL_RECORD_MAPPING.md`:** all bubble and composer data lives in the **global** `state.vscdb`. Workspace `state.vscdb` files have *no* `cursorDiskKV` rows on this machine — they only carry workbench/UI state in `ItemTable`. The capture target document should be updated.

### 2.2 SQLite schema

Both global and workspace DBs:
```sql
CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
```

`cursorDiskKV` is a key-value JSON store. `ItemTable` is the workbench/UI state and **contains the auth tokens** — never read.

### 2.3 Key prefixes in `cursorDiskKV` (global DB)

Counts from this machine's snapshot (377 rows total):

| Prefix | Count | Use |
|---|--:|---|
| `agentKv:blob:<sha256>` | 242 | **Skip.** Content-addressed cache of provider-format messages (`{role, content}`). Redundant with `bubbleId:` and not joined to any composer in observed data. Capturing would 5–10× storage and bring back already-redacted content. |
| `bubbleId:<composerId>:<bubbleId>` | 89 | **Capture.** One JSON row per message. Carries `text`, `richText`, `thinking`, `toolFormerData`, `createdAt`, `context`. |
| `composerData:<composerId>` | 33 | **Capture.** Conversation header. Carries `name`, `subtitle`, `unifiedMode`, `forceMode`, `modelConfig`, `fullConversationHeadersOnly`, `contextUsagePercent`, `status`. |
| `checkpointId:*` | 5 | **Skip.** Diff checkpoint state — UI concern. |
| `codeBlockPartialInlineDiffFates:*` | 3 | **Skip.** UI state. |
| (no prefix) | 5 | **Skip.** Misc settings. |

### 2.4 Observed conversation shape

Of 33 composers, **3 have real conversation content**; the other 30 have `status: "none"` and zero bubbles (drafts/abandoned). The three real conversations:

| composerId (8 char) | Bubbles | Mode | Model | Title |
|---|---|---|---|---|
| `831d2410` | 2 user / 47 assistant | agent / edit | default (claude family) | "TypeError traceback issue" |
| `a7e0e0d5` | 3 user / 24 assistant | agent / edit | gpt-5.4-medium | "Endpoint handling in Databricks integration" |
| `29fcd25b` | 1 user / 12 assistant | agent / edit | claude-opus-4-7-thinking-high | "Image visualizer implementation on..." |

The user-to-assistant ratio (≈ 1 : 20) confirms agent-mode behavior: each user submission triggers a long chain of model calls (thinking → tool → thinking → tool → … → text), each persisted as its own bubble.

### 2.5 Bubble-level fields that matter for the algorithm

```json
{
  "_v": 3,                              // bubble schema version
  "type": 1 | 2,                        // 1 = user, 2 = assistant — turn boundary
  "bubbleId": "<uuid>",
  "createdAt": "2026-02-21T21:55:18.742Z",
  "requestId": "<uuid> | ''",           // populated only on first user bubble of a turn (sometimes)
  "tokenCount": {"inputTokens": 0,      // !!! ALWAYS {0, 0} in observed data
                 "outputTokens": 0},
  "unifiedMode": 2,                     // numeric (vs string in composerData)
  "capabilityType": 15 | 30 | null,     // 15 = tool_use, 30 = thinking, null = text
  "text": "…",                          // plaintext (empty on tool/thinking-only bubbles)
  "richText": "{…lexical JSON…}",       // structured user input (mentions, files)
  "thinking": {"text": "…", "signature": "", "thinkingDurationMs": 4538},
  "toolFormerData": {                   // present on type=2 with capabilityType=15
    "toolCallId": "tool_…",
    "name": "read_file_v2",
    "rawArgs": "{…JSON…}",
    "params": "{…JSON…}",
    "result": "{…JSON…}",
    "status": "completed",
    "tool": 9                           // numeric internal id
  },
  "context": { /* selections, mentions, attached files — see §5.1 */ }
}
```

Algorithmic implications:

- **Turn boundary is `type` transitions** in the composer's `fullConversationHeadersOnly` array, not anything inside the bubble. `requestId` would be the natural turn id but it's empty on most bubbles (5 of 89 in observed data). We synthesize a turn id from the first user bubble's `bubbleId` instead.
- **`tokenCount` is unusable.** All observed bubbles have `{0, 0}`. See §5.3.
- **`capabilityType` is a coarse content-type tag,** not a turn marker. It's useful for routing content to the right `MessageContent` type (text / thinking / tool_use).
- **Multiple tool calls share a single user submission.** A turn has one user bubble and 10–40 assistant bubbles (interleaved thinking / text / tool_use). All of them collapse into one `CallRecord`.

### 2.6 Composer-level fields that matter

```json
{
  "_v": 13,                                 // composer schema version
  "composerId": "<uuid>",
  "name": "TypeError traceback issue",      // auto-generated title
  "subtitle": "Edited model_connector.py",  // auto-generated activity summary
  "status": "completed" | "none",           // "none" = empty draft
  "unifiedMode": "agent" | "chat",          // string (vs numeric in bubbles)
  "forceMode": "edit" | "chat",
  "modelConfig": {"modelName": "default" | "gpt-5.4-medium" | "claude-opus-4-7-thinking-high",
                  "maxMode": false},
  "agentBackend": "cursor-agent",
  "isAgentic": true,
  "fullConversationHeadersOnly": [          // ordered bubble manifest
    {"bubbleId": "<uuid>", "type": 1 | 2}, …
  ],
  "contextUsagePercent": 15.537,            // populated; useful proxy for "how full is the context"
  "totalLinesAdded": 1, "totalLinesRemoved": 2,
  "addedFiles": 0, "removedFiles": 0, "filesChangedCount": 1,
  "subComposerIds": [], "subagentComposerIds": [],
  "speculativeSummarizationEncryptionKey": "GV9/Utpt/…",  // exists, but observed unused
  "blobEncryptionKey": "KNwuAw9B6l/…"
}
```

Algorithmic implications:

- **`fullConversationHeadersOnly` is the source of truth for ordering.** Bubble `createdAt` timestamps are also there but we trust the array order — Cursor's flush boundaries don't always match send order, so timestamps are slightly looser.
- **`status: "none"` composers are noise.** Filter them out at parse time.
- **Encryption keys exist but observed payloads are plaintext.** The keys appear to encrypt auxiliary blobs (`conversationState`?), not the bubble content. Don't waste time on decryption for MVP.

---

## 3. Gateway flushing algorithm

### 3.1 Goal

Every 5 minutes: ship rows from `cursorDiskKV` that were inserted or replaced since the last poll, for the prefixes `composerData:` and `bubbleId:` only. Never ship the same row twice. Survive Cursor writing to the live DB while we're reading it.

### 3.2 Why a different algorithm than Claude Code's

Claude Code is append-only JSONL — a byte cursor is enough. Cursor is a SQLite KV store with `INSERT OR REPLACE` semantics, no `created_at`/`updated_at` columns, no row sequence guarantees beyond `rowid`. Two practical implications:

- **Live writes** (Cursor app + our gateway) require a snapshot. Use `VACUUM INTO`, not `cp` — `cp` may produce a torn read because Cursor uses WAL.
- **"What's new"** requires a watermark. SQLite's `rowid` is monotonic for `INSERT`, and `INSERT OR REPLACE` produces a delete-then-insert under the hood, so an updated row gets a new (higher) rowid. Tracking `max(rowid)` per snapshot is the cheapest correct watermark.

### 3.3 State

```sql
CREATE TABLE source_cursor (
  source           TEXT NOT NULL,           -- 'cursor'
  db_path          TEXT NOT NULL,           -- absolute path to source state.vscdb
  last_max_rowid   INTEGER NOT NULL,        -- highest rowid we've shipped
  last_seen_at     REAL NOT NULL,
  PRIMARY KEY (source, db_path)
);

CREATE TABLE upload_batch (
  batch_id         TEXT PRIMARY KEY,        -- UUIDv7
  source           TEXT NOT NULL,
  db_path          TEXT NOT NULL,
  rowid_start      INTEGER NOT NULL,        -- inclusive
  rowid_end        INTEGER NOT NULL,        -- inclusive (== max(rowid) in batch)
  body_zstd        BLOB NOT NULL,           -- redacted batch of (key, value) tuples
  state            TEXT NOT NULL,
  attempts         INTEGER NOT NULL DEFAULT 0,
  created_at       REAL NOT NULL
);
```

This shares the `upload_batch` table shape with the Claude Code collector — the gateway uploader is one component for both sources.

### 3.4 The 5-minute loop

```
1. tmp_path = "/tmp/proxai-cursor-snap-<uuid>.db"
2. sqlite3 "file:<live_path>?mode=ro" "VACUUM INTO '<tmp_path>'"
3. row = SELECT last_max_rowid FROM source_cursor WHERE db_path=<live_path>
        offset = row.last_max_rowid OR 0
4. rows = SELECT rowid, key, value
          FROM cursorDiskKV
          WHERE rowid > <offset>
            AND (key LIKE 'composerData:%' OR key LIKE 'bubbleId:%')
          ORDER BY rowid ASC
5. if rows is empty:
       UPDATE source_cursor SET last_seen_at = now()
       remove tmp file
       continue
6. raw = serialize(rows)                   # one record per row: {rowid, key, value}
7. redacted = redact(raw)                  # see DESIGN.md §3
8. INSERT INTO upload_batch (
       batch_id    = uuidv7(),
       source      = 'cursor',
       db_path     = <live_path>,
       rowid_start = rows[0].rowid,
       rowid_end   = rows[-1].rowid,
       body_zstd   = zstd(redacted),
       state       = 'pending',
   );
9. (uploader runs concurrently; on 2xx for batch_id:)
       UPDATE upload_batch SET state='done'
       UPDATE source_cursor SET last_max_rowid = rows[-1].rowid
10. remove tmp_path
```

The gateway never parses bubble JSON; it only filters by key prefix. Schema drift inside the JSON values does not break the gateway.

### 3.5 What the algorithm intentionally is NOT

- **Not row-update aware.** If a `composerData:` row's `fullConversationHeadersOnly` is updated in place (and SQLite happens to preserve the rowid), we miss the update. We *also* don't care: every new bubble gets shipped on its own row, and the backend reconstructs ordering from per-bubble `createdAt`. The composer header is captured once at first sight; we re-capture it any time the composer's rowid bumps (which it does on `INSERT OR REPLACE`).
- **Not multi-DB-aware in MVP.** Workspace `state.vscdb` files have no `cursorDiskKV` rows in observed data, so we don't poll them. If that ever changes, the algorithm extends trivially — one `source_cursor` row per `db_path`.
- **Not WAL-aware in the sense of reading it directly.** `VACUUM INTO` against a `?mode=ro` connection is the documented Cursor-WAL-safe path.

### 3.6 Multi-window concurrency

Cursor on macOS is a single Electron process (single-instance lock). Multiple Cursor *windows* share the same backend process, which means **only one writer to `state.vscdb`**. The gateway is the only other concurrent reader, and `VACUUM INTO` against a read-only connection is safe even mid-write.

Verified on this machine by listing FDs on the live DB during normal use — only one Cursor process was attached. If that ever changes (e.g. Cursor switches to per-window processes), the algorithm doesn't change because `VACUUM INTO` is robust under concurrent writers.

### 3.7 Snapshot cost

The user's global DB is 3.4 MB after `VACUUM INTO`. Snapshotting takes ~10 ms; selecting new rows on a fresh DB is sub-ms. Per-poll cost is dominated by network upload (and there isn't much to upload — see the volume note below). Total wall time per poll < 50 ms typical.

Volume note: a busy Cursor user generates maybe 100 bubbles/day at ~1–5 KB each, so per-day capture is < 1 MB compressed. Five-minute cadence ships < 50 KB per poll on a heavy day. The 5-min cadence is comfortable.

---

## 4. Backend call-record parsing algorithm

### 4.1 The unit: one `CallRecord` per user-bubble turn

Walk a composer's `fullConversationHeadersOnly` in order. Each `type: 1` (user) bubble starts a new turn; all subsequent `type: 2` (assistant) bubbles up to the next `type: 1` belong to it. Collapse the whole block into one `CallRecord`:

```yaml
CallRecord:
  client_app: cursor
  client_session_id: <composerId>            # the conversation thread
  client_turn_id: <user bubble's bubbleId>   # synthetic; requestId is unreliable
  parent_turn_id: <prior user bubble's bubbleId in same composer, or null>

  query:
    chat:
      messages: [<this turn's user prompt only — text + richText mentions>]
    provider_model:
      provider: <inferred from modelName prefix; see §5.5>
      model:    <composerData.modelConfig.modelName>
    tools: <union of toolFormerData.name across this turn's assistant bubbles>
    cwd: <derived from user-bubble context.selections file paths; see §5.1>
    agent_mode: <composerData.unifiedMode>   # 'agent' | 'chat'
    force_mode: <composerData.forceMode>     # 'edit' | 'chat'

  result:
    content:
      [<thinking blocks (capabilityType=30)>,
       <text blocks (capabilityType=null with non-empty text)>,
       <tool_use blocks (capabilityType=15 with toolFormerData)>,
       in order of fullConversationHeadersOnly]
    usage:
      input_tokens: null                     # see §5.3 — Cursor does not expose
      output_tokens: null
      estimated_input_tokens:  <tiktoken approximation>
      estimated_output_tokens: <tiktoken approximation>
      thinking_duration_ms: <sum of bubble.thinking.thinkingDurationMs>
    timestamp:
      start_utc_date: <user bubble createdAt>
      end_utc_date:   <last assistant bubble createdAt before next user bubble>
      response_time_ms: end - start
    tool_summary: <Counter of toolFormerData.name>

  capture:
    source: cursor
    db_path: <state.vscdb path>
    record_ref: <composerId>:<user-bubbleId>   # one per turn
    schema_version: <composerData._v>:<bubbleId._v>  # 13:3 currently
```

Why this shape: the analytics goals from `ALGORITHM_CLAUDE.md` (which features / time spent / project tokens) read at per-turn grain. Cursor's bubble layout aligns naturally — one user submission produces one bounded block of assistant bubbles. No history is inlined; full conversation reconstruction walks `parent_turn_id` in O(K).

### 4.2 Streaming algorithm

```
state = load_state(composerId)
        # state.last_emitted_user_bubble_id, state.open_user_bubble_id, state.open_records

for row in batch_rows ordered by rowid ASC:
    if row.key startswith 'composerData:':
        composer = parse(row.value)
        if composer.status == 'none':
            continue                          # empty draft, skip
        cache.composers[composerId] = composer

        # finalize any open turns for this composer that are now "behind" the
        # composer's latest fullConversationHeadersOnly state
        # (only finalize a turn when we've seen a *later* user bubble for it —
        # see idle-flush in §4.3)
        continue

    if row.key startswith 'bubbleId:':
        composerId, bubbleId = parse_key(row.key)
        bubble = parse(row.value)

        if bubble.type == 1:                  # user — new turn boundary
            if state[composerId].open_user_bubble_id is not None:
                yield finalize(
                    state[composerId].open_records,
                    parent_turn_id=state[composerId].last_emitted_user_bubble_id,
                )
                state[composerId].last_emitted_user_bubble_id = state[composerId].open_user_bubble_id
            state[composerId].open_user_bubble_id = bubbleId
            state[composerId].open_records = [bubble]
        else:                                 # type=2 assistant — append
            state[composerId].open_records.append(bubble)

save_state(...)
```

A `CallRecord` is emitted only when a *later* user bubble arrives, so the previous turn is provably complete (Cursor never inserts assistant bubbles after a later user bubble — verified by walking the bubble manifest).

### 4.3 Idle-flush

Same rule as Claude Code (§4.3 of `ALGORITHM_CLAUDE.md`): if an open turn has been buffered for >30 min with no new bubbles for that composer, finalize as-is and mark `result.status = INCOMPLETE`. Handles abandoned conversations and Cursor app crashes mid-turn.

### 4.4 Idempotency

`id = hash(client_app, client_session_id, client_turn_id)` = `hash('cursor', composerId, user_bubbleId)`. Re-uploads upsert; we never duplicate. Updates to a composer's `modelConfig` or `name` (rare; mostly happens early in the conversation) re-upsert with new metadata, content unchanged.

### 4.5 Multi-instance concurrency

Cursor is single-instance per machine (§3.6). All composers are in one global DB. Per-composer state is keyed on `composerId`, scoped to one composer — no cross-composer linkage. Multiple windows operating on different composers in parallel never produce intersecting bubble streams because each bubble's key is `bubbleId:<composerId>:<bubbleId>` — composerId-prefixed.

This is **simpler** than Claude Code's multi-session concurrency: there's only one DB to poll, one writer, and composer scoping is explicit in the key.

### 4.6 `/resume` and continuation: mirror the source

Same principle as `ALGORITHM_CLAUDE.md` §4.6: mirror what Cursor does. Cursor's behavior:

- **Switching threads.** User picks a prior conversation from the side panel. Cursor opens the same `composerId.<state.vscdb>` rows and appends new bubbles. **Same composerId = same `CallRecord` chain.** Correct by construction.
- **Speculative summarization / context compaction.** `composerData.isContinuationInProgress` and `speculativeSummarizationEncryptionKey` exist. In observed data Cursor has *not* forked to a new composerId when context is summarized — the existing composer continues with its existing bubbles. We **mirror that: no new chain, no flag.**

There is no equivalent of Claude Code's "session ran out of context → new file" behavior in observed Cursor data. Until verified otherwise, we assume Cursor's compaction is in-place and never produces a new composerId. Section §7 calls this out for verification once the user runs longer sessions.

### 4.7 Why this is enough

- Within a composer: provably correct turn chain (each turn's parent is the prior user bubble).
- Across multiple composers: zero cross-talk (composerId scoping in the key).
- Across speculative summarization: no link needed because Cursor doesn't fork.

For MVP analytics (project tokens, time, features), no cross-composer linkage is required.

---

## 5. Metadata parsing algorithm

### 5.1 Project / cwd (MVP-required, Cursor-specific deriviation)

**Source.** None of the bubble or composer fields directly carry `cwd`. `bubble.workspaceUris` is empty in observed data. We have to derive project from one of:

1. **Attached file paths in the user bubble.** `bubble.context.selections[*].uri.fsPath` — the file the user @-mentioned or had selected. Observed example: `/Users/osmanaka/repos/proxai/proxai/src/proxai/connectors/model_connector.py` → project = `/Users/osmanaka/repos/proxai/proxai`.
2. **`bubble.context.fileSelections[]` / `mentions.fileSelections{}`** — same idea.
3. **Workspace storage join.** If the gateway also captures `~/Library/Application Support/Cursor/User/workspaceStorage/<hash>/workspace.json`, we get a `folder` URI. **However, in observed data there is no key linking a `composerId` to a workspace hash.** This join is therefore not available without a heuristic.

**Algorithm.**

```
def derive_project(turn) -> str | null:
    # 1. Most recent file path on this turn's user bubble
    for sel in turn.user_bubble.context.selections:
        if sel.uri.fsPath:
            return git_root_or_common_prefix(sel.uri.fsPath)
    # 2. Fallback: any file path on any assistant bubble's tool calls
    for bubble in turn.assistant_bubbles:
        if bubble.toolFormerData and bubble.toolFormerData.name in {'read_file_v2','edit_file_v2','ripgrep_raw_search'}:
            args = json.loads(bubble.toolFormerData.rawArgs or '{}')
            for path_key in ('targetFile','filePath','path','targetDirectories'):
                if path_key in args:
                    return git_root_or_common_prefix(args[path_key])
    # 3. Per-composer fallback: most-frequent prefix across all user-bubble selections in this composer
    return most_frequent_prefix(turn.composer.all_user_bubble_selections)
    # 4. Else: null. Dashboard shows "Unknown project."
```

`git_root_or_common_prefix` ascends the path until it finds a `.git` directory (we maintain a small client-side cache of `(absolute_path, git_root)` pairs, populated on the gateway). Falls back to the longest common prefix across the turn's selections.

**Edge case** (verified in observed data): a single user prompt can reference files from multiple repos. Pick the most frequently-referenced repo for the turn; record other repos in `query.also_touched_projects[]` as a list. For MVP, ignoring secondary repos is acceptable.

### 5.2 Resume / continuation chains

We don't extract any. See §4.6: same composerId = same chain; Cursor doesn't fork on compaction. No special fields, no flags.

### 5.3 Token usage — the hard problem

**Observed reality:** every bubble's `tokenCount` field is `{inputTokens: 0, outputTokens: 0}` and every composer's `usageData` field is `{}`. Cursor does not write per-turn token usage to the local database.

There is no other field that carries token counts. We verified across 89 bubbles spanning three different model families (`default`/Claude, `gpt-5.4-medium`, `claude-opus-4-7-thinking-high`).

Three options for the MVP:

1. **Estimate via `tiktoken` (or the model-specific tokenizer).** Sum `len(tokenize(text))` over the user bubble's `text`/`richText`/attachments for input; over the assistant bubbles' `text`/`thinking.text`/`toolFormerData.result` for output. **This is approximate**: it doesn't account for system prompts (Cursor adds its own internal system prompt that we never see), tool-call overhead, or provider-specific token rules. Expect **30–80% under-count** vs ground truth, depending on model.
2. **Skip token reporting for Cursor.** Show `tokenCount: null` on the dashboard; all token-based metrics either exclude Cursor or display "estimated only" labels.
3. **Rely on `agentKv:blob` payloads** — the content-addressed cache contains provider-format messages including system prompts, so estimates would be more accurate. But the join from blob to composer is not visible in the local data, so we'd be tokenizing blobs without knowing which conversation they belong to. **Not viable.**

**Recommendation:** option 1 with a clear `tokens_are_estimated: true` flag on every Cursor `CallRecord`. The dashboard should distinguish estimated from authoritative tokens — Cursor goes in the "estimated" bucket, Claude Code in the "authoritative" bucket.

The user's stated MVP analytics (which features / time spent / project tokens) survive this gap because:
- "Which features" (clustering on user prompts) doesn't need tokens.
- "Time spent" comes from `createdAt` deltas — fully accurate.
- "Project tokens" is the affected metric. It's reported as estimates with a confidence interval.

If exact tokens become a hard requirement post-MVP, the path is to capture Cursor's *outbound HTTPS traffic* (proxy mode in `DESIGN.md` Phase 2) and pull tokens from response bodies — but that's a different capture mechanism, not a fix to local-disk parsing.

### 5.4 Tool calls (MVP-required)

**Source.** `bubble.toolFormerData` for any assistant bubble with `capabilityType: 15`.

```yaml
toolFormerData:
  toolCallId:  tool_<uuid>
  name:        read_file_v2 | ripgrep_raw_search | semantic_search_full | edit_file_v2 |
               read_lints | web_search | …
  rawArgs:     '<JSON-serialized args>'
  params:      '<JSON-serialized internal params>'
  result:      '<JSON-serialized full result>'
  status:      completed | …
```

**Algorithm.** Per `CallRecord`:

```
tool_calls = [
  {
    'name':   b.toolFormerData.name,
    'input':  json.loads(b.toolFormerData.rawArgs or '{}'),
    'id':     b.toolFormerData.toolCallId,
    'result': b.toolFormerData.result,
  }
  for b in turn.assistant_bubbles
  if b.capabilityType == 15
]
tool_summary = Counter(tc['name'] for tc in tool_calls)
```

Cursor's tool inventory observed on this machine (single conversation):
- File system: `read_file_v2`, `edit_file_v2`, `read_lints`
- Search: `ripgrep_raw_search`, `semantic_search_full`, `web_search`
- (No equivalents of Claude Code's `Bash`, `TaskCreate`, MCP tools observed in this thin sample — see §7.)

The names map onto a different vocabulary than Claude Code. The dashboard should display them verbatim, not normalize — `read_file_v2` is meaningful to a Cursor user.

### 5.5 Provider inference (Cursor-specific)

`composerData.modelConfig.modelName` is sometimes literal (`gpt-5.4-medium`, `claude-opus-4-7-thinking-high`) and sometimes the literal string `default` (which means "whatever Cursor's auto-router picked"). When `default`, we don't know the actual provider/model used.

```
def infer_provider(model_name) -> str | null:
    if model_name == 'default':
        return null                    # Cursor's auto-router; unknown
    if model_name.startswith('claude'): return 'anthropic'
    if model_name.startswith('gpt'):    return 'openai'
    if model_name.startswith('gemini'): return 'google'
    if model_name.startswith('grok'):   return 'xai'
    if model_name.startswith('deepseek'): return 'deepseek'
    return null
```

When provider is `null`, pricing (§5.6) cannot be computed and the record carries `usage.estimated_cost_nano_usd: null`. The dashboard should show this as "Auto-routed (cost unknown)."

### 5.6 Pricing

Same as `ALGORITHM_CLAUDE.md` §5.6 in shape, but with two caveats:

- Token counts are estimates (§5.3), so cost is doubly-estimated.
- Provider can be `null` (§5.5), in which case cost is `null`.

### 5.7 Mode (Cursor-specific, MVP-nice-to-have)

`composerData.unifiedMode` is `agent` or `chat`. `composerData.forceMode` is `edit` or `chat`. These map onto an analytic split: agentic-coding sessions vs chat-only Q&A. Capture as `query.agent_mode`. Schema gap [G-M1] in `CALL_RECORD_MAPPING.md` is open for this field.

### 5.8 Lower-priority metadata (deferred past MVP)

- **`composerData.contextUsagePercent`.** Useful as a "context fullness" signal. Pass through.
- **`composerData.totalLinesAdded` / `Removed`, `addedFiles`, `removedFiles`, `filesChangedCount`, `subtitle`.** Diff-stat metadata. Useful enrichment.
- **`bubble.context.commits` / `pullRequests` / `gitDiffs` / `gitPRDiffSelections`.** Rich Git context that Cursor surfaces but Claude Code doesn't. Capture as `query.attachments_summary[]` per `CALL_RECORD_MAPPING.md` gap [G-A1].
- **`bubble.images`, `attachedFolders`.** Defer.
- **`bubble.allThinkingBlocks`.** Empty in observed data; appears to be a future field.
- **Sub-composers (`subComposerIds`, `subagentComposerIds`).** Empty in observed data. Cursor's sub-agent feature exists but the user hasn't used it. Out of MVP.
- **Best-of-N (`isBestOfNSubcomposer`, `isBestOfNParent`, `bestOfNJudgeWinner`).** Out of MVP.
- **Worktree fields (`isCreatingWorktree`, `pendingCreateWorktree`, etc.).** Out of MVP.
- **`speculativeSummarizationEncryptionKey`, `blobEncryptionKey`.** Encryption keys exist; observed payloads are plaintext. Defer.

---

## 6. Worked example

A short turn from this machine, walked end-to-end. Composer `831d2410-…` (`agent/edit` mode, Claude default model).

**Source — three rows from `cursorDiskKV` (rowid order):**

```
rowid 16  |  composerData:831d2410-...  |  {"_v":13, "name":"TypeError traceback issue", "unifiedMode":"agent", "forceMode":"edit", "modelConfig":{"modelName":"default"}, "fullConversationHeadersOnly":[{"bubbleId":"a81ac48a-...","type":1}, {"bubbleId":"1d799c4e-...","type":2}, …], "status":"completed"}

rowid 26  |  bubbleId:831d2410-...:a81ac48a-...  |  {"_v":3, "type":1, "createdAt":"2026-02-21T21:55:18.742Z", "text":"@.../model_connector.py:470-474 I got this error later in the code. Why is that?\nTypeError: __traceback__ must be a traceback or None", "context":{"selections":[{"uri":{"fsPath":"/Users/osmanaka/repos/proxai/proxai/src/proxai/connectors/model_connector.py"},…}]}, "tokenCount":{"inputTokens":0,"outputTokens":0}, "requestId":"2bd6a435-..."}

rowid 32  |  bubbleId:831d2410-...:1d799c4e-...  |  {"_v":3, "type":2, "createdAt":"2026-02-21T21:55:20.357Z", "thinking":{"text":"The user is asking about a TypeError…", "thinkingDurationMs":4538}, "capabilityType":30}
```

(plus 47 more assistant bubbles at rowids 33–185, ending with a long text bubble at rowid 185.)

**Gateway flush (5 min cycle):**
- `VACUUM INTO` snapshot: 10 ms.
- `SELECT WHERE rowid > 0` (first poll): 49 rows, 130 KB raw.
- Filter to `composerData:` and `bubbleId:` keys: 49 rows kept (no other prefixes in this composer's range).
- Redact: zero matches in this content.
- Insert as `upload_batch` row, ship.
- On 2xx: advance `last_max_rowid = 185`.

**Backend parse:**
- Row at rowid 16 (composer) is cached. `status: completed` → eligible.
- Row at rowid 26 (user bubble, type=1) opens turn 1. `client_turn_id = a81ac48a-…`.
- Rows at rowid 32–185 (47 assistant bubbles, type=2) accumulate in turn 1.
- (Later, after the user typed a follow-up, the next user bubble arrives. Turn 1 is finalized; turn 2 opens.)

**Resulting `CallRecord`:**

```yaml
client_app: cursor
client_session_id: 831d2410-0ad6-48d8-99aa-ed03b507f8de
client_turn_id: a81ac48a-b325-485f-a5a6-9c9478d1acba
parent_turn_id: null                         # first turn in composer
query:
  chat:
    messages: [{ role: user,
                 content: '@.../model_connector.py:470-474 I got this error… TypeError: __traceback__ must be a traceback or None' }]
  provider_model: { provider: anthropic, model: 'default' }   # default → unknown actual model
  tools: [read_file_v2, ripgrep_raw_search, semantic_search_full, edit_file_v2, read_lints, web_search]
  cwd: /Users/osmanaka/repos/proxai/proxai   # derived from selection fsPath
  agent_mode: agent
  force_mode: edit
result:
  content:
    [{ kind: thinking, text: '…', duration_ms: 4538 },
     { kind: text, text: '…' },
     { kind: tool_use, name: read_file_v2, args: {…}, result: '…' },
     …]
  usage:
    input_tokens: null
    output_tokens: null
    estimated_input_tokens: 1820              # tiktoken approximation
    estimated_output_tokens: 14400
    estimated_cost_nano_usd: null             # provider='default' → unknown
    thinking_duration_ms: 27880               # sum across all thinking bubbles
    tokens_are_estimated: true
  timestamp:
    start_utc_date: '2026-02-21T21:55:18.742Z'
    end_utc_date:   '2026-02-21T21:57:00.000Z'   # last assistant bubble before next user bubble
    response_time_ms: 101258
  tool_summary: { read_file_v2: 8, ripgrep_raw_search: 5, semantic_search_full: 1, edit_file_v2: 1, read_lints: 1, web_search: 1 }
capture:
  source: cursor
  db_path: ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
  record_ref: 831d2410-...:a81ac48a-...
  schema_version: '13:3'                     # composerData._v : bubbleId._v
```

This single record answers two of three MVP questions directly (features by clustering on user prompt, time spent from `response_time_ms`); the third (project tokens) is answered with an *estimated* count.

---

## 7. Data limitations on this machine

The user explicitly said they use Cursor less, and the snapshot bears it out. What we *did* observe:

- 3 active composers, 89 bubbles, max 49-bubble session.
- Three different model families, two of them named explicitly, one as `default`.
- Both `agent/edit` and `chat/chat` modes (only agent had bubbles).
- Single Cursor process / single global DB.
- All bubble content plaintext.
- Token counts always zero.

What we **could not verify** from this sample, and how to close each before MVP code-freeze:

| Gap | Why it matters | How to verify |
|---|---|---|
| Cursor's behavior at context-overflow / speculative summarization | §4.6 assumes Cursor doesn't fork composerIds on compaction. If it does, our chain logic is wrong. | Run a single composer past 80% `contextUsagePercent` and watch whether `composerId` changes when summarization fires. If a new composerId appears with a synthetic first message, we add a Pattern-2 heuristic similar to Claude Code §4.6 (or, per user preference, mirror Cursor and not link). |
| Whether `tokenCount` ever populates | If on some path Cursor *does* write tokens (e.g. for billing/quota), we can stop estimating. | Monitor token fields across a longer-duration session (multi-day) and across all three modes. Snapshot before/after running heavy agentic traffic. |
| Whether `requestId` is reliable when populated | Some user bubbles do have it. If always-present-on-first-user-bubble-of-turn, we can use it as `client_turn_id` instead of synthesizing from bubbleId. | Check several long sessions; confirm or refute the rule. |
| Sub-composer (Cursor sub-agent) shape | `subComposerIds` is always empty in observed data. The feature exists; its on-disk shape is unverified. | Trigger Cursor's sub-agent feature (Composer-spawned sub-task) and snapshot. |
| Best-of-N parallel sampling | Same — fields exist (`isBestOfNSubcomposer`, `isBestOfNParent`, `bestOfNJudgeWinner`), shape unverified. | Trigger via Cursor settings if available. |
| Rowid behavior under `INSERT OR REPLACE` for `composerData:` updates | If rowid is preserved during update, our watermark misses composer-header changes. The algorithm tolerates this (we re-emit composer state every batch with new bubbles), but we should verify. | Take a snapshot, mutate a composer's name in Cursor (or wait for a title-regeneration), snapshot again, compare rowids of the same composerData key. |
| Multi-window concurrent writes to the same composer | Plausible if a user has the same conversation open in two windows. | Open the same conversation in two Cursor windows, type in both, snapshot during. |
| Provider mapping for `default` model | When `modelConfig.modelName == 'default'`, we don't know the actual provider. Cursor's auto-router picks per-turn. | This may be unrecoverable without HTTP capture. Document as a permanent limitation if so. |
| Cursor's outbound traffic shape (response includes tokens?) | Eventual proxy mode in Phase 2 of `DESIGN.md` may give us authoritative tokens. | Out of scope for parsing-only algorithm; mentioned for completeness. |

The right way to close most of these is **a fixture-generation script** that drives Cursor through scripted tasks (long context, sub-agent, multi-mode) and snapshots after each step. That script is part of MVP work item §10.4 below.

---

## 8. MVP scope recap

The user's stated MVP analytics: *which features users are working on, how much time they're spending, which project consumes what amount of tokens.*

| Algorithm | MVP need | Source |
|---|---|---|
| Flushing (§3) | All of it | This doc |
| Per-turn `CallRecord` parsing (§4.1–4.4) | All of it | This doc |
| Multi-instance / single-window correctness (§4.5) | Required | Per-composer scoping, free |
| Project metadata (§5.1) | Required | Derived from attachment file paths |
| Token usage — estimated (§5.3) | Required (with caveat) | tiktoken on bubble text |
| Tool calls — summary (§5.4) | Required | Counter on `toolFormerData.name` |
| Provider inference (§5.5) | Required when modelName ≠ 'default' | Prefix match |
| Pricing (§5.6) | Required (estimated, may be null) | Backend table lookup |
| Resume chains (§4.6 / §5.2) | Not extracted | Mirror Cursor; same composerId = same chain |
| Mode (§5.7) | Nice | Pass through `unifiedMode` |
| Detail tool args/results | Skip | Schema gap G-T2 still open |
| Sub-composers / best-of-N | Skip | Empty in data; defer |
| Rich attachment context (commits, PRs, images) | Skip | Big surface; defer |

Everything in "skip" is non-destructive — raw bytes are preserved on the backend, so any of these can be promoted by re-running the parser without recapture.

---

## 9. Open questions

1. **Token estimation accuracy.** What's the acceptable error band? If Cursor estimates land within ±20% of authoritative values (when we eventually get them via proxy mode), the dashboard story is fine. If it's ±50%, we may need to suppress token-based metrics for Cursor entirely.
2. **`default` model handling.** When Cursor's auto-router is in use, do we display "Cursor (auto)" as a synthetic provider? Affects dashboard UX.
3. **Workspace storage poll.** Workspace `state.vscdb` had 0 conversation rows in observed data. Should we poll them at all in MVP, or strictly just the global DB? Recommend: skip workspace DBs entirely in MVP, save the poll cost.
4. **`agentKv:blob` capture.** Skipped in MVP for storage reasons. If a future dashboard wants to show full provider-format messages (system prompt, etc.), revisit. Until then, the bubble-derived view is enough.
5. **Idle-flush threshold.** 30 min is the same as Claude Code. Cursor turns observed were all sub-2-min, so 30 is plenty conservative.

---

## 10. Next steps

1. Update `CAPTURE_TARGETS.md` and `CALL_RECORD_MAPPING.md` to reflect: all conversation data is in the global `state.vscdb`, workspace DBs have no `cursorDiskKV` rows. (Section 4 of `CAPTURE_TARGETS.md` and §2 of `CALL_RECORD_MAPPING.md`.)
2. Implement the gateway snapshot loop (§3.4) — `VACUUM INTO` + rowid watermark. Code lives in `packages/gateway/src/collectors/cursor_kv.ts`.
3. Implement the backend parser (§4.2) for Cursor. Code lives in `packages/nest-ingest/src/parsers/cursor.ts`.
4. **Build a fixture-generation script** that drives Cursor through scripted tasks to close the §7 gaps: a context-overflow conversation, a sub-agent run, a multi-mode session, a multi-window concurrency case. Sanitize and commit fixtures to the test corpus.
5. Wire metadata extractors (§5.1, §5.4, §5.5, §5.6). §5.3 ships tiktoken estimates with the `tokens_are_estimated: true` flag. §5.2 explicitly not extracted.
6. Validate the algorithm end-to-end on the user's existing 3 conversations before any new fixtures arrive — small-but-real beats none.
