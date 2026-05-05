# Algorithms — Flushing, Parsing, Metadata

**Status:** Draft v0.2 (grounded in real on-disk data from this machine)
**Owner:** ProxAI
**Last updated:** 2026-04-29
**Scope:** Backend-and-gateway algorithms for turning raw coding-agent transcripts into `CallRecord`s. Companion to `DESIGN.md` (component split), `CAPTURE_TARGETS.md` (file paths), `CALL_RECORD_MAPPING.md` (field-by-field schema mapping).

---

## 1. What this doc decides

Three algorithms, each with one decision:

1. **Flushing (gateway).** Tail append-only JSONL files by per-file byte cursor; ship only new bytes every 5 minutes. §3.
2. **Call-record parsing (backend).** One `CallRecord` per `promptId` (one user submit + all of its assistant iterations and tool calls, collapsed). Each record stores a `parent_turn_id` pointing to the prior turn — a per-turn linked list. No history is inlined. §4.
3. **Metadata parsing (backend).** Project from `cwd`, tokens summed per turn, tool-call summary as a `Counter`, pricing computed downstream from raw counts. Compaction and cross-session resume are deliberately *not* tracked — we mirror Claude Code's own behavior, which treats each new session file as fresh. §5.

The ground truth this doc is built on is the user's own `~/.claude/projects/` tree (roughly 130 MB, 72 sessions for the `proxai` project alone, longest single session 8.4 MB / 858 records). All concrete numbers below are measured, not estimated.

---

## 2. Observed shape of Claude Code on-disk data

This section is short on purpose — `CALL_RECORD_MAPPING.md` already covers the field-level mapping. Here we only call out what affects the *algorithm*.

### 2.1 File layout

```
~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl       ← append-only stream
~/.claude/projects/<encoded-cwd>/<session-uuid>/             ← per-session sidecar dir
    tool-results/<short-hash>.txt                            ← externalized tool outputs
    subagents/agent-<id>.jsonl + agent-<id>.meta.json        ← Task-tool sub-sessions
    memory/                                                  ← per-project agent memory
~/.claude/sessions/<pid>.json                                ← live PID→session index
~/.claude/history.jsonl                                      ← global user-input log (not used; see §9)
```

`<encoded-cwd>` replaces both `/` and `_` with `-`, which is **lossy** — `proxai_gateway` and `proxai-gateway` both encode to `-...-proxai-gateway`. We never derive paths from the directory name; we always read `cwd` from inside the records.

### 2.2 Record shape

Each line is one JSON object. Top-level `type` is the only guaranteed dispatch key. Observed values, with frequency in a typical large session (681 lines):

| `type` | Count | Interpretation |
|---|--:|---|
| `assistant` | 274 | Model turn (text, thinking, tool_use blocks) |
| `user` | 163 | User-typed prompt OR tool_result envelope OR `<command-name>` slash-command |
| `file-history-snapshot` | 46 | File state snapshot at edit boundaries |
| `permission-mode` | 47 | Mode change marker |
| `ai-title` | 47 | Title regenerations |
| `last-prompt` | 46 | UI cursor state |
| `system` | 30 | Lifecycle events, *not* system prompts |
| `attachment` | 22 | Pasted files / images / deferred-tool deltas |
| `task_reminder` | 18 | Internal harness reminders |
| Others | 88 | `queue-operation`, `params_changed`, `date_change`, `unavailable`, … |

Algorithmic implications:

- **Assistant + user are ~64% of records and 100% of conversational signal.** The other 36% are lifecycle/UI noise.
- **Records form a linked list via `parentUuid` → `uuid`.** The chain is single-parent in practice (no branching observed across this user's data), so we can treat it as a list, not a tree, for MVP.
- **A user "turn" can span many records.** A single user submit produces one `user` record but the assistant's reply commonly spans 5–20 `assistant` records (one per `tool_use` cycle), interspersed with `user` records carrying `tool_result` content. They share a `promptId`. The `promptId` is the natural turn boundary, not `uuid`.
- **Compaction is detected by content, not by a flag.** Look for the literal prefix `"This session is being continued from a previous conversation"` in a `user` record's `message.content`. We saw `isCompactSummary` only twice in 130 MB of data — content sniffing is more reliable.

### 2.3 Token usage shape

Every `assistant` record carries `message.usage`:
```json
{
  "input_tokens": 6,
  "output_tokens": 444,
  "cache_creation_input_tokens": 8004,
  "cache_read_input_tokens": 14865,
  "cache_creation": {"ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 8004},
  "service_tier": "standard",
  "iterations": [...]
}
```

Three things matter for the algorithm:

- `input_tokens` is **the delta**, not the total — Anthropic returns "new tokens since last cached chunk." Per-turn billing math has to add `cache_creation_input_tokens` and `cache_read_input_tokens` back.
- `iterations[]` is per-retry, not per-tool-call. Multiple iterations means the SDK retried, not that the agent did multiple thinking passes.
- The shape is stable across `version` `2.1.109` through `2.1.122` in observed data.

---

## 3. Gateway flushing algorithm

### 3.1 Goal

Every 5 minutes, for each watched JSONL file: ship the bytes that were appended since the last successful upload. Never ship the same bytes twice. Never miss bytes. Survive crashes mid-poll, file rotation, file deletion, and the file growing while we're reading it.

### 3.2 State

A small SQLite buffer in `~/.proxai/gateway.db` (already in `DESIGN.md` §6) holds, per file:

```sql
CREATE TABLE file_cursor (
  source       TEXT NOT NULL,           -- 'claude-code' | 'codex' | 'cursor'
  path         TEXT NOT NULL,           -- absolute path to the JSONL
  inode        INTEGER NOT NULL,        -- detect rotation
  size_at_last INTEGER NOT NULL,        -- bytes confirmed shipped
  mtime_at_last REAL NOT NULL,          -- diagnostic only
  last_record_uuid TEXT,                -- last shipped record's uuid (Claude Code)
  last_seen_at REAL NOT NULL,
  PRIMARY KEY (source, path, inode)
);

CREATE TABLE upload_batch (
  batch_id     TEXT PRIMARY KEY,         -- UUIDv7
  source       TEXT NOT NULL,
  path         TEXT NOT NULL,
  inode        INTEGER NOT NULL,
  byte_start   INTEGER NOT NULL,
  byte_end     INTEGER NOT NULL,         -- exclusive; size_at_last after upload succeeds
  body_zstd    BLOB NOT NULL,            -- redacted bytes, compressed
  state        TEXT NOT NULL,            -- 'pending' | 'inflight' | 'done' | 'failed'
  attempts     INTEGER NOT NULL DEFAULT 0,
  created_at   REAL NOT NULL
);
```

The `(source, path, inode)` triple is the idempotency key. `byte_start`/`byte_end` plus the bundled bytes is the upload payload.

### 3.3 The 5-minute loop, per file

```
1. stat(path) → (cur_inode, cur_size, cur_mtime)
2. row = SELECT * FROM file_cursor WHERE source=? AND path=?
3. if row missing OR row.inode != cur_inode:
       # new file or rotation — start from 0
       offset = 0
       inode  = cur_inode
   else:
       offset = row.size_at_last
       inode  = row.inode
4. if cur_size <  offset:        # file truncated
       reset offset to 0; log a WARN
5. if cur_size == offset:        # no new bytes
       UPDATE file_cursor SET last_seen_at = now()
       continue
6. raw = read(path, offset, cur_size - offset)        # one syscall
7. (clean_chunk, last_complete_byte) = split_at_last_newline(raw)
       # if raw doesn't end in \n, hold back the trailing partial line
       # — JSONL writers flush mid-line during high write rates
8. redacted = redact(clean_chunk)                     # see DESIGN.md §3
9. INSERT INTO upload_batch (
       batch_id     = uuidv7(),
       source       = 'claude-code',
       path         = path,
       inode        = inode,
       byte_start   = offset,
       byte_end     = offset + last_complete_byte,
       body_zstd    = zstd(redacted),
       state        = 'pending',
   );
10. (uploader runs concurrently; on 2xx for batch_id:)
       UPDATE upload_batch SET state='done'
       UPDATE file_cursor SET size_at_last = byte_end, mtime_at_last = cur_mtime
       last_record_uuid = parse last `uuid` field from chunk        # for backend dedup hint
```

### 3.4 What the algorithm intentionally is NOT

- **Not line-aware on the gateway.** The gateway never parses JSON. It splits at the last newline and ships bytes. Schema drift never breaks the gateway.
- **Not a tail-follower.** No `inotify`/`FSEvents` for MVP. Pure 5-min poll + lazy `stat`. (Phase 2 adds FSEvents purely as a wake-up nudge — the algorithm above doesn't change.)
- **Not transactional with the source.** We never write to the source files. If a poll crashes after step 6 and before step 9, the next poll re-reads the same range — that's fine; the backend is idempotent on `(source, path, inode, byte_start, byte_end)`.

### 3.5 Why 5 minutes is the right cadence

- Real-world session size delta in 5 min is bounded: in this user's longest active session (8.4 MB over 7 days = ~1.2 MB/day), a 5-min slice is ~4 KB — single-packet upload.
- The user's stated MVP analytics ("which features, time spent, project token usage") aggregate at hour/day grain. Sub-minute freshness adds zero value.
- A failed poll is a non-event because the file is append-only — the next poll catches up.

### 3.6 Multi-file concurrency

Per-file cursor rows are independent. The poll loop iterates serially over `glob(~/.claude/projects/*/*.jsonl)`. With 72 sessions × `stat` + maybe-read, total wall time per poll is dominated by network upload, not file I/O — measured `stat` + 4 KB read ≈ 0.3 ms/file on this disk; serial poll for 72 files ≈ 25 ms. No need for concurrency in MVP.

### 3.7 Rotation, deletion, busy files

- **Rotation.** Claude Code never rotates session files (one file per session, append-only forever). The `inode` check in step 3 covers the unobserved case where it ever does.
- **Deletion.** If `stat()` fails ENOENT, we keep the cursor row but never ship more. The backend already has whatever was shipped.
- **Live writers.** Step 7 (split-at-last-newline) handles partial last line. We confirmed by inspection that Claude Code writes one record per `write()` call — partials are rare and recover on the next poll.

---

## 4. Backend call-record parsing algorithm

### 4.1 The unit: one `CallRecord` per `promptId`

A `promptId` groups all records produced by one user submit:
- 1 `user` record (the typed prompt, possibly with attachments)
- N `assistant` records (one per tool_use cycle: thinking → tool_use → wait → resume)
- M `user` records carrying `tool_result` content blocks (paired with assistant tool_use blocks)
- Lifecycle records (`permission-mode`, `attachment`, …) interleaved

We collapse all of them into one `CallRecord`. Each `CallRecord` carries `parent_turn_id` = the prior `promptId` in the same `sessionId`. Walking the chain gives the full conversation in O(K). **No history is inlined.**

```yaml
CallRecord:
  client_app: claude-code
  client_session_id: <sessionId>
  client_turn_id: <promptId>
  parent_turn_id: <prior promptId in same sessionId, or null on first turn>

  query:
    chat: { messages: [<this turn's user prompt only>] }
    provider_model: { provider: anthropic, model: <message.model> }
    tools: <union of tool_use names this turn>
    cwd: <cwd at time of turn>

  result:
    content: [<assistant text + thinking + tool_use + tool_result, in order>]
    usage: <sum of all assistant.usage in this promptId — see §5.3>
    timestamp:
      start_utc_date: <user record ts>
      end_utc_date:   <last assistant record ts>
      response_time_ms: end - start
    tool_summary: <Counter of tool_use names — see §5.4>

  capture:
    source: claude-code
    path: <jsonl path>
    record_ref: <promptId>
    schema_version: <message.version>
```

Why this shape: the MVP analytics — *which features, time spent, project tokens* — all read at per-turn grain. Token usage sums across rows. Time is `end - start` per row. Feature inference is "embed `query.chat.messages[0]`, cluster." No query needs prior turns inlined on the row. On the rare path that needs full history (replay, support, debug), walking `parent_turn_id` is an O(K) index range scan in Postgres with K typically 20–100. Cheap.

Sub-agents (Task tool, `isSidechain=true`) are their own `CallRecord`s, with `parent_turn_id` pointing to the spawning assistant turn. They live in `<session-dir>/subagents/agent-*.jsonl` and parse the same way.

### 4.2 Streaming algorithm

The backend ingester is a pure function from `(raw_bytes, prior_state)` → `(call_records, new_state)`. Per file:

```
state = load_state(sessionId)         # { open_promptId, open_records, last_emitted_promptId }

for line in lines(raw_bytes):
    rec = json.loads(line)            # tolerant; bad line → log and skip
    if rec.type not in {'user', 'assistant', 'attachment'}:
        continue                       # lifecycle noise; doesn't go into CallRecord

    if rec.promptId != state.open_promptId:
        if state.open_promptId is not None:
            yield finalize(
                state.open_records,
                parent_turn_id=state.last_emitted_promptId,
            )
            state.last_emitted_promptId = state.open_promptId
        state.open_promptId = rec.promptId
        state.open_records  = []

    state.open_records.append(rec)

# do NOT finalize the still-open promptId — its tool-call iterations may
# not all be in this batch yet. Wait for the next promptId or for the
# idle timeout (§4.3).

save_state(sessionId, state)
```

A `CallRecord` is emitted only when a *later* `promptId` arrives, proving the previous one is complete. The last open turn stays buffered until the next batch arrives or the session goes idle.

### 4.3 Idle-flush

If an open `promptId` has been buffered for >30 min with no new bytes, finalize it as-is and mark `result.status = INCOMPLETE`. Handles crashed agents, sessions where the user walked away mid-turn, and sessions that ended without compaction. 30 min is longer than any single observed `promptId` duration (longest was ~8 min) but short enough that end-of-day dashboards aren't missing anything.

### 4.4 Idempotency

Each `CallRecord` has a deterministic `id = hash(client_app, client_session_id, client_turn_id)`. Re-uploads (gateway retry, backend re-parse) upsert by that id; we never duplicate.

### 4.5 Multi-session concurrency

A typical user runs 5–10 Claude Code sessions in parallel — different repos, different terminals, sometimes the same repo in different cwds. The linked list stays correct because **each session is a separate JSONL file**:

```
~/.claude/projects/-Users-os-repos-A/<sessionId-1>.jsonl   → chain 1
~/.claude/projects/-Users-os-repos-A/<sessionId-2>.jsonl   → chain 2 (same project, parallel)
~/.claude/projects/-Users-os-repos-B/<sessionId-3>.jsonl   → chain 3
…
```

The `(source, path, inode)` cursor in §3.2 is per-file, so the gateway tails six files independently. The backend parser runs §4.2 once per file, with state keyed on `sessionId`. **`parent_turn_id` is scoped to one `sessionId`** — a turn in session 1 can never accidentally link to session 2 because the parser never looks outside the file.

Edge cases:
- **Same `cwd`, multiple concurrent sessions.** Each gets its own file and its own chain. Project rollups (§5.1) `SUM` across all sessions for that `cwd`; chain reconstruction stays per-session.
- **One session writing while another is being polled.** Per-file cursor is independent; no cross-file lock.
- **Process crash / kill.** `~/.claude/sessions/<pid>.json` is removed but the JSONL file stays. The chain is still walkable; subsequent resume appends to the same file (§4.6, Pattern 1).

### 4.6 `/resume` and continuation: mirror the source

We mirror Claude Code's own behavior: **a new `sessionId` is a new session, full stop.** No cross-session linking, no heuristic parents, no continuation flags. If Claude Code itself doesn't write a back-reference, we don't invent one.

This collapses to two patterns:

**Pattern 1 — Same-session resume.** Restart, `claude --resume`, or `/resume` of an existing session: Claude Code re-opens the *same* `sessionId.jsonl` and appends. The gateway's per-file cursor picks up where it left off; the backend keeps adding turns to the same `sessionId`; the `parent_turn_id` chain extends unbroken. **Correct by construction.**

**Pattern 2 — New file (auto-compaction or fresh start).** Claude Code opens a new `sessionId.jsonl`. We treat it as a fresh session. The first turn has `parent_turn_id = null`. If the first user prompt happens to be a compaction summary (the literal `"This session is being continued from a previous conversation"` prefix), it lands in `query.chat.messages[0].content` like any other prompt. We don't tag it, don't link it, don't extract it.

Why this is enough:

- Within a session: provably correct chain.
- Across concurrent sessions: zero cross-talk (per-file scoping, §4.5).
- Across the auto-compaction boundary: no link at all — same as the agent's own model. The MVP analytics (project tokens, time, features) aggregate over `(user_id, project, day)` and don't read cross-session edges. Compaction events show up as one session ending and another starting in the same `cwd` — which is what they are.

If a future product requirement genuinely needs cross-session threading (e.g. a "task timeline" view), it can be added later as a separate enrichment pass over historical raw bytes. Capturing now does not block that — the data is already preserved.

---

## 5. Metadata parsing algorithm

The user listed seven things to extract: project repo, `/resume` history, repo path, compaction info, token usage, tool calls, pricing usage. Each is independent and below; ordering is by MVP priority.

### 5.1 Project (MVP-required)

**Source.** `cwd` field on every `user`/`assistant` record. Always present in observed data.

**Algorithm.**
- Per `CallRecord`: copy `cwd` straight through to `query.cwd`.
- Per project rollup: `project_key = realpath(cwd)`. Cluster `CallRecord`s by it. Display name = `basename(project_key)`.
- We do **not** trust the directory-encoded name (`<encoded-cwd>`) because the encoding is lossy.
- We do **not** look up `git remote get-url origin` — that's a side-channel call out to the developer's machine; not available to the backend, and the gateway shouldn't shell out either.

**Edge case.** Within one session, `cwd` can change (user `cd`s mid-session). We pin per-`CallRecord`, not per-session. A session with mixed `cwd` values is fine — each turn lands in the right project bucket.

### 5.2 Resume / continuation chains

We don't extract any. See §4.6: a new `sessionId` is a new session. Claude Code itself doesn't write a back-reference to a prior session, so we don't invent one. If a compaction summary is the first user prompt of a new session, it gets stored as a normal user prompt — no special field, no flag.

This is a deliberate MVP simplification, not a deferred capability. The raw bytes are preserved in object storage (§3), so a later product feature that needs cross-session threading can re-derive it without recapture.

### 5.3 Token usage (MVP-required)

**Source.** `assistant.message.usage` on every assistant record.

**Algorithm.** Per `CallRecord` (one `promptId`):
```
usage_total = {
  input_tokens          : sum(rec.message.usage.input_tokens for rec in assistants),
  output_tokens         : sum(rec.message.usage.output_tokens for rec in assistants),
  cache_creation_tokens : sum(rec.message.usage.cache_creation_input_tokens for rec in assistants),
  cache_read_tokens     : sum(rec.message.usage.cache_read_input_tokens for rec in assistants),
  service_tier          : last assistant's service_tier (most recent decision),
  iterations            : sum(len(rec.message.usage.iterations) for rec in assistants),
}
```

Stored on `result.usage` (typed fields where the schema covers them; the rest into `result.usage.provider_specific` per `CALL_RECORD_MAPPING.md` §4 passthrough).

**Important arithmetic.** The number you bill / report is:
```
billable_input  = input_tokens + cache_creation_tokens + cache_read_tokens × cache_read_discount
billable_output = output_tokens
```
For Anthropic (Claude Code), `cache_read_discount = 0.1` and `cache_creation` is billed at `1.25× input` rate. Per-provider pricing tables live in the backend, not the gateway; the gateway only ships raw counts.

### 5.4 Tool calls (MVP-required)

**Source.** `tool_use` content blocks inside `assistant.message.content`. Each has `name`, `input`, `id`. Paired `tool_result` blocks live inside the next `user` record's `message.content`.

**Algorithm.** Per `CallRecord`:
```
tool_calls = []
for assistant_rec in records_in_promptId:
    for block in assistant_rec.message.content:
        if block.type == 'tool_use':
            tool_calls.append({
                'name'  : block.name,                    # 'Read', 'Edit', 'Bash', ...
                'input' : block.input,                   # full args; redacted
                'id'    : block.id,
                'result': lookup_paired_result(block.id),  # may live in a tool-results/<hash>.txt sidecar
            })

tool_summary = Counter(tc.name for tc in tool_calls)
```

Two storage shapes:
- **Per-turn detail.** All `tool_calls` go into `result.content` as `ToolContent` blocks. Schema gap [G-T2] in `CALL_RECORD_MAPPING.md` is open for `arguments` and `result` fields.
- **Per-turn summary.** `tool_summary` (`{Read: 4, Edit: 2, Bash: 1, Task: 1}`) goes into a small `tool_summary` field for fast dashboard rollups. This is what powers "which features is the user working on" without needing to scan blob fields.

**Externalized tool results.** Some sessions have `<session-dir>/tool-results/<hash>.txt` holding tool outputs that were too large to inline. The gateway captures these files separately and the backend joins them by hash at parse time. If the file is missing (gateway dropped it for size), we set `result_truncated=true` and store first 4 KB.

**Sub-agents.** A `tool_use` with `name: 'Task'` (or `name: 'Agent'`) implies a sub-agent run. The result references a `subagents/agent-<id>.jsonl` file. The backend parses *that* file as its own session and emits sub-agent `CallRecord`s with `parent_turn_id` pointing to this turn.

### 5.5 Compaction info

We don't extract any. Same rationale as §5.2: Claude Code itself writes compaction summaries as plain user messages, with no in-record flag we can trust (the `isCompactSummary` field appeared only twice in 130 MB of observed data). The summary text lands in the normal user-prompt field and that's it.

If a future product feature needs "compaction events per session" as a metric, it can be re-derived by re-parsing the raw bytes for the literal prefix — no recapture required.

### 5.6 Pricing (MVP-required)

**Source.** Not in the JSONL. Computed downstream from `(provider_model, usage)`.

**Algorithm.** Backend has a `pricing_table` keyed by `(provider, model_name, effective_date)`:
```
def estimate_cost(usage, provider_model, ts):
    p = pricing_table.lookup(provider_model.provider, provider_model.model, ts)
    return (
        usage.input_tokens          * p.input_per_token
      + usage.cache_creation_tokens * p.cache_creation_per_token
      + usage.cache_read_tokens     * p.cache_read_per_token
      + usage.output_tokens         * p.output_per_token
    )
```
Stored as `result.usage.estimated_cost_nano_usd` (matching `CallRecord` convention).

Pricing table updates are independent of capture — when Anthropic changes a price, we backfill `estimated_cost` on historical records by re-running this function. Capture has lossless inputs (raw token counts), so backfill is exact.

### 5.7 Lower-priority metadata (deferred past MVP)

- **`gitBranch`.** Pass through. Useful but not MVP.
- **`version` (Claude Code build).** Tagged on every `CallRecord` for parser dispatch and schema-drift triage.
- **`permissionMode`.** Lifecycle marker. Capture on `CallRecord` if present; otherwise default. Not on the analytics path.
- **`slug`.** Per-message slug used by Claude Code for plan-file linkage. We see it on most assistant records; ignore for MVP.
- **`ai-title`.** Auto-generated session titles. Useful for human-readable dashboard rows. Capture once per session at the latest `ai-title` record. Lossy is fine.
- **Sub-agent meta.** `<session-dir>/subagents/agent-*.meta.json`. Carries sub-agent config — out of MVP.

---

## 6. Worked example

A short turn from this exact session, walked end-to-end.

**Source — three lines of `9d2576ec-9d07-4ff3-83d8-4368186bb4e3.jsonl`:**
```json
{"type":"user","promptId":"a1060146-...","message":{"role":"user","content":"Ok we made the basic structure..."},"uuid":"47e4cb38-...","timestamp":"2026-04-29T13:34:23.793Z","cwd":"/Users/osmanaka/repos/proxai/proxai_gateway","sessionId":"9d2576ec-...","version":"2.1.122"}
{"type":"assistant","promptId":"a1060146-...","message":{"model":"claude-opus-4-7","content":[{"type":"thinking","thinking":"..."}],"usage":{"input_tokens":6,"cache_creation_input_tokens":8004,"cache_read_input_tokens":14865,"output_tokens":444}},"uuid":"25e15bdb-...","timestamp":"2026-04-29T13:34:28.715Z"}
{"type":"assistant","promptId":"a1060146-...","message":{"model":"claude-opus-4-7","content":[{"type":"text","text":"I'll explore the current project structure..."}]},"uuid":"2a08a3f7-...","timestamp":"2026-04-29T13:34:29.154Z"}
```

**Gateway flush (5 min cycle):**
- `stat()` → file grew by 1247 bytes. Read range `[12340, 13587)`.
- Last byte is `\n`; clean chunk = entire 1247 bytes.
- Redact (no secrets in this chunk). Insert as `upload_batch` row, ship.
- On 2xx: advance `file_cursor.size_at_last = 13587`.

**Backend parse:**
- Stream sees three records sharing `promptId=a1060146-...`.
- (Later, the assistant emits a `tool_use` for `Bash`, the next user record carries the `tool_result`, the assistant resumes with another text/tool_use, etc. — say 12 more records total in this `promptId`.)
- When the next `promptId` (or 30-min idle) arrives, finalize.

**Resulting `CallRecord`:**
```yaml
client_app: claude-code
client_app_version: '2.1.122'
client_session_id: 9d2576ec-...
client_turn_id: a1060146-...
parent_turn_id: 0af333cd-...           # the /clear turn just before, same sessionId
query:
  chat: { messages: [{role:user, content:'Ok we made the basic structure...'}] }
  provider_model: { provider:anthropic, model:claude-opus-4-7 }
  tools: [Read, Bash, Edit, TaskCreate, TaskUpdate]   # union of tool_use names this turn
  cwd: /Users/osmanaka/repos/proxai/proxai_gateway
result:
  content: [<thinking>, <text>, <tool_use Read>, <tool_result>, <tool_use Bash>, ...]
  usage:
    input_tokens: 6 + 5 + 4 + ... = 47          # summed across all assistant recs
    output_tokens: 4982
    cache_creation_tokens: 11633
    cache_read_tokens: 162910
    estimated_cost_nano_usd: 312_400_000        # filled by backend from pricing table
  timestamp:
    start_utc_date: '2026-04-29T13:34:23.793Z'
    end_utc_date:   '2026-04-29T13:42:11.402Z'
    response_time_ms: 467609
  tool_summary: { Read: 4, Bash: 6, Edit: 0, TaskCreate: 7, TaskUpdate: 4 }
capture:
  source: claude-code
  path: ~/.claude/projects/-Users-osmanaka-repos-proxai-proxai-gateway/9d2576ec-...jsonl
  record_ref: a1060146-...
  schema_version: '2.1.122'
```

This single record answers the user's three MVP questions directly:
- **Which feature?** Embed `query.chat.messages[0].content`; cluster.
- **Time spent?** `result.timestamp.response_time_ms`.
- **Project tokens?** Group by `query.cwd`, sum `result.usage.*`.

No history was inlined. To replay the conversation, walk `parent_turn_id` from this record back to session start — average chain length 20–40, single index range scan.

---

## 7. Codex and Cursor — same algorithm, different inputs

The flushing algorithm is **literally unchanged** for Codex (also append-only JSONL at `~/.codex/sessions/.../rollout-*.jsonl`). For Cursor, we replace "tail JSONL by byte offset" with "snapshot SQLite via `VACUUM INTO` and diff against a per-row watermark" — the boundaries shift but the state-table shape is the same.

The call-record parsing algorithm is **the same shape, different boundary key:**

| Agent | Turn boundary | Notes |
|---|---|---|
| Claude Code | `promptId` | Native; multiple records share it. |
| Codex | `response_item` boundary in rollout | Each `response_item` is one assistant turn; surrounding `event_msg` records belong to it. |
| Cursor | `bubbleId` (assistant bubble) + paired user bubble | Less reliable; bubbles carry only loose ordering. |

Metadata parsing diverges most. See `CALL_RECORD_MAPPING.md` §2 for the per-agent field map.

**MVP cut:** ship Claude Code first, Codex second, Cursor third. Each one is one `parser.ts` module on the backend implementing the algorithm in §4.2 with agent-specific record types. The gateway code is identical for all three.

The multi-session and resume-correctness rules from §4.5–4.6 carry over directly. Codex sessions are also one-file-per-session under `~/.codex/sessions/...`, so per-file scoping holds. Cursor's bubble model is the awkward one — bubbles from concurrent workspaces share the same `state.vscdb`, so workspace identity has to come from the SQLite path or the workspace hash (already noted in `CALL_RECORD_MAPPING.md` §2 Cursor notes).

---

## 8. MVP scope recap

The user asked: *"MVP will only try to parse which features users are working on, how much time they're spending, which project consumes what amount of tokens."*

To answer those three questions, the MVP needs only:

| Algorithm | MVP need | Source |
|---|---|---|
| Flushing (§3) | All of it | This doc |
| Per-turn `CallRecord` parsing (§4.1–4.4) | All of it | This doc |
| Multi-session correctness (§4.5) | Required | Per-file scoping, free |
| Project metadata (§5.1) | Required | `cwd` straight through |
| Token usage (§5.3) | Required | `usage` summed per turn |
| Tool calls (§5.4) — summary only | Required | `tool_summary` counter |
| Pricing (§5.6) | Required | Backend table lookup |
| Resume chains | Not extracted | Mirror Claude Code; new file = new session (§4.6) |
| Compaction events | Not extracted | Same — re-derivable from raw bytes if ever needed (§5.5) |
| Tool calls — detail | Skip | Schema gap G-T2 still open |
| Sub-agents | Skip | Detected but not emitted as separate records yet |

Everything in the "skip" list is **non-destructive** — the raw bytes are on the backend, so any of these can be promoted by re-running the parser without re-capture.

---

## 9. Open questions

1. **Sub-agent linking.** When `parent_turn_id` points to a turn whose `tool_use Task` spawned the sub-agent, is the dashboard view "show parent and children inline" or "separate view"? Affects schema, not algorithm.
2. **`history.jsonl` use.** It has cross-project user-input history (display, project, sessionId, timestamp), no responses. Tempting for a "what did the user ask today?" widget, but redundant with per-session capture and contains pasted secrets in `pastedContents`. **Skip for MVP.**
3. **Idle-flush threshold.** 30 min is a guess. Calibrate after one week of beta data.
4. **Token billing math for non-Anthropic providers in Claude Code.** Claude Code only talks to Anthropic today, but Cursor/Codex span providers. Pricing table in §5.6 has to be per-provider — already in the design.
5. **Plan-file linkage.** `~/.claude/plans/<slug>.md` correlates with per-message `slug` field. Useful enrichment ("the agent worked from this plan") but slug-to-plan mapping is many-to-one and fragile. **Out of MVP.**

---

## 10. Next steps

1. Lock the `CallRecord` schema gaps `G-S1`–`G-S6`, `G-T2` (tracked in `CALL_RECORD_MAPPING.md` §3) so the backend can write typed fields instead of `provider_specific` blobs.
2. Implement the gateway flush loop (§3) — pure file I/O, no schema knowledge. Code lives in `packages/gateway/src/collectors/jsonl_tail.ts`.
3. Implement the backend parser (§4.2) for Claude Code first. Code lives in `packages/nest-ingest/src/parsers/claude_code.ts`.
4. Build a fixture corpus from this user's `~/.claude/projects/` (sanitized) — must include at least one parallel-session scenario, one same-session resume, and one auto-compacted-into-new-file scenario (verified to be parsed as a fresh session) — and run the parser against it as a golden-file test.
5. Wire the metadata extractors (§5.1, §5.3, §5.4, §5.6). §5.2 and §5.5 are explicitly not extracted (see §4.6).
