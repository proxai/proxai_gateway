# Codex Algorithms — Flushing, Parsing, Metadata

> Last reviewed: 2026-05-06 — algorithm shape is current with two updates:
>
> 1. **Three sidecar tables in scope, not one.** The gateway captures
>    `threads`, `thread_dynamic_tools`, and `thread_spawn_edges` from the
>    `state_*.sqlite` sidecar. The contract enforces this set both client-side
>    (skip-list in `src/sources/codex/codex.constants.ts`) and server-side
>    (`nest-contract.md` §4 / §15 reject other tables with 400). Earlier docs
>    that say "table `threads` only" are out of date.
>
> 2. **Vacuum-induced rowid regression** is detected at capture time and
>    handled by re-keying the source via `#gen=N` suffix on `source_path` —
>    same pattern as Cursor (see `src/services/buffer/vacuum-detect.ts`). The
>    new `source_path_hash` is a fresh stream from the backend's perspective.
>
> Backend parsing (turn boundary on `task_started` → `task_complete`, sub-agent
> edges from `thread_spawn_edges`, dynamic tool inventory from
> `thread_dynamic_tools`) still matches what this doc describes.

**Status:** Draft v0.1 (grounded in real on-disk data from this machine; sample size is small — see §7)
**Owner:** ProxAI
**Last updated:** 2026-04-29
**Scope:** Backend-and-gateway algorithms for turning Codex's on-disk transcripts into `CallRecord`s. Companion to `ALGORITHM_CLAUDE.md` and `ALGORITHM_CURSOR.md`. Source-of-truth for paths is `CAPTURE_TARGETS.md`; field-level mapping is in `CALL_RECORD_MAPPING.md`.

> **Read `ALGORITHM_CLAUDE.md` first.** This doc only argues the points where Codex differs from Claude Code; everything that's the same (per-turn unit, parent-pointer linked list, mirror-the-source for resume, idle-flush, idempotency) is just referenced.

---

## 1. What this doc decides

Three algorithms, each with one decision — same structure as `ALGORITHM_CLAUDE.md`:

1. **Flushing (gateway).** **Two-source poll** every 5 min: tail per-rollout JSONL files by **byte cursor** (same algorithm as Claude Code) AND snapshot `~/.codex/state_5.sqlite` via `VACUUM INTO` for the `threads` table by **rowid watermark** (same algorithm as Cursor). §3.
2. **Call-record parsing (backend).** One `CallRecord` per **`turn_id`** — Codex provides explicit turn boundaries via `event_msg/task_started` (open) and `event_msg/task_complete` (close). Linked list via `parent_turn_id` = previous turn_id in the same thread. §4.
3. **Metadata parsing (backend).** Codex's `state_5.threads` row gives us **cwd, git_sha, git_branch, git_origin_url, model_provider, model, reasoning_effort, sandbox_policy, approval_mode** as typed columns — the **richest header metadata of the three agents.** Per-turn token usage is *not* exposed (only thread cumulative `tokens_used`); same gap as Cursor. §5.

Where Codex meaningfully diverges from Claude Code: it has a **sidecar SQLite (`state_5.sqlite`) that the gateway must read alongside the JSONL**, an **explicit `turn_id` field** that makes turn boundaries trivial to detect, an **encrypted `reasoning` payload** that we capture as a metadata-only block, and **per-turn tokens are missing** (same as Cursor).

The ground truth is the user's `~/.codex/` tree on this machine: 3 rollouts (425 total lines, 1.5 MB), 3 thread rows with full git provenance (all three pointed at proxai/proxai or proxai_nest, gpt-5.5, medium reasoning effort, workspace-write sandbox, on-request approval, cli 0.126.0-alpha.8). **Sample is thin.** §7 lists what could not be verified.

---

## 2. Observed shape of Codex on-disk data

### 2.1 File layout

```
~/.codex/
    sessions/<YYYY>/<MM>/<DD>/rollout-<ISO-timestamp>-<thread-uuid>.jsonl   ← append-only stream
    state_5.sqlite                  ← sidecar metadata (threads, dynamic tools, spawn edges, …)
    state_5.sqlite-wal              ← WAL; ignore (we VACUUM INTO instead)
    state_5.sqlite-shm              ← shared mem; ignore
    session_index.jsonl             ← global thread title index (370 bytes here)
    auth.json                       ← OpenAI tokens — NEVER READ
    logs_2.sqlite                   ← application logs, not LLM payloads — NEVER READ
    config.toml, models_cache.json, .codex-global-state.json   ← user/system config; skip
    memories/, plugins/, skills/, vendor_imports/, tmp/, cache/, sqlite/   ← out of scope
```

Compared to Claude Code's `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, the Codex path is **date-partitioned, not project-partitioned**. The thread UUID in the filename matches `state_5.threads.id` and the `payload.id` of the rollout's `session_meta` record.

### 2.2 SQLite schema (`state_5.sqlite`) — what matters

Three tables in scope; the rest are skipped per `CAPTURE_TARGETS.md` and the "skip lists are part of the implementation" enforcement.

```sql
-- Per-thread (= per-session) metadata. The richest header data of the three agents.
CREATE TABLE threads (
    id              TEXT PRIMARY KEY,         -- matches rollout filename UUID
    rollout_path    TEXT NOT NULL,            -- joins back to JSONL
    created_at      INTEGER, updated_at INTEGER,
    created_at_ms   INTEGER, updated_at_ms INTEGER,
    source          TEXT,                     -- e.g. 'vscode'
    model_provider  TEXT,                     -- 'openai' (direct, ✓)
    model           TEXT,                     -- 'gpt-5.5' (direct, ✓)
    cli_version     TEXT,                     -- '0.126.0-alpha.8'
    cwd             TEXT NOT NULL,            -- '/Users/.../proxai_nest'
    title           TEXT NOT NULL,            -- auto-generated
    first_user_message TEXT,
    sandbox_policy  TEXT NOT NULL,            -- JSON: {type, network_access, …}
    approval_mode   TEXT NOT NULL,            -- 'on-request'
    reasoning_effort TEXT,                    -- 'medium' (maps to ThinkingType)
    memory_mode     TEXT NOT NULL,            -- 'enabled'
    tokens_used     INTEGER NOT NULL DEFAULT 0,    -- !!! cumulative thread total — see §5.3
    has_user_event  INTEGER, archived INTEGER, archived_at INTEGER,
    git_sha         TEXT, git_branch TEXT, git_origin_url TEXT,    -- ✓ FULL git provenance
    agent_nickname  TEXT, agent_role TEXT, agent_path TEXT
);

-- Dynamic tools registered for this thread (does NOT include built-in tools).
CREATE TABLE thread_dynamic_tools (
    thread_id   TEXT, position INTEGER, name TEXT, description TEXT,
    input_schema TEXT, defer_loading INTEGER, namespace TEXT,
    PRIMARY KEY(thread_id, position)
);

-- Parent → child thread relationships. EMPTY in observed data; relevant for the
-- agent-spawn feature (Codex's sub-agent equivalent).
CREATE TABLE thread_spawn_edges (
    parent_thread_id TEXT, child_thread_id TEXT PRIMARY KEY, status TEXT
);
```

**Tables we explicitly SKIP** (privacy, irrelevance, or known-empty in observed data): `_sqlx_migrations`, `agent_jobs`, `agent_job_items`, `jobs`, `backfill_state`, `stage1_outputs` (Codex-internal memory/summarization output), `thread_goals`, `device_key_bindings`, `remote_control_enrollments`. Skip-list enforcement same as in `DESIGN.md` §8.

### 2.3 Rollout JSONL — top-level types

Counts from the user's longest rollout (the 110-line Apr 29 session); ratios are stable across the three observed rollouts.

| Top-level `type` | Count | Has `turn_id`? | Use |
|---|--:|:-:|---|
| `session_meta` | 1 (always first) | – | One per file. Carries cwd, originator, cli_version, source, model_provider, **`base_instructions.text` = the full system prompt**. |
| `event_msg` | 48 | ✓ on most | UI/control events — turn boundaries, user/assistant message mirrors, exec results. |
| `response_item` | 58 | ✗ | The actual model interactions. Subtype dispatch on `payload.type`. |
| `turn_context` | 3 | ✓ | One per turn boundary. Snapshot of cwd / sandbox / approval / model at turn start. |

### 2.4 `event_msg` subtypes

| `payload.type` | Count | Carries | Role in algorithm |
|---|--:|---|---|
| `task_started` | 3 | `turn_id`, `started_at`, `model_context_window`, `collaboration_mode_kind` | **Turn-boundary OPEN** ✓ |
| `task_complete` | 3 | `turn_id`, `completed_at`, `duration_ms`, `time_to_first_token_ms`, `last_agent_message` | **Turn-boundary CLOSE** ✓ |
| `user_message` | 3 | `message`, `images`, `text_elements` | Mirror of user input — the easy-to-read view |
| `agent_message` | 6 | `message`, `phase`, `memory_citation` | Mirror of final assistant text |
| `exec_command_end` | 16 | `call_id`, `command`, `cwd`, `parsed_cmd`, `stdout`, `stderr`, `exit_code`, `duration` | Bash tool result (rich) |
| `web_search_end` | 6 | `call_id`, `query`, `action.queries[]` | Web-search result |
| `token_count` | 10 | `info`, `rate_limits` | **Quota / rate-limit info — NOT per-turn tokens.** |
| `thread_name_updated` | 1 | `thread_id`, `thread_name` | Title regeneration |

Algorithmic implications:

- **`turn_id` is the cleanest turn-boundary id of the three agents.** It appears on every event_msg subtype that defines or operates within a turn.
- **`task_started` → `task_complete` brackets are the canonical turn span.** All `response_item` records between them belong to the turn (response_items themselves do *not* carry turn_id; we attach by position).
- **`token_count` is misleadingly named.** It's quota/rate-limit info, *not* per-turn token counts. Per-turn tokens are not in the rollout at all.

### 2.5 `response_item` subtypes (the actual content)

| `payload.type` | Count | Content shape |
|---|--:|---|
| `message` | 11 | `role` ∈ {`developer`, `user`, `assistant`}, `content[]` with `input_text` / `output_text` items. **The `developer` role is Codex's internal system prompt** (sandbox / permissions instructions); it is *not* user-typed. |
| `reasoning` | 9 | `summary: []`, `content: null`, **`encrypted_content: '<base64>'`** — opaque blob. We cannot read the reasoning text. |
| `function_call` | 16 | `name` (e.g. `exec_command`), `arguments` (JSON string), `call_id` |
| `function_call_output` | 16 | `call_id`, `output` (plaintext, includes stdout / exit code) |
| `web_search_call` | 6 | `status`, `action.queries[]` |

Algorithmic implications:

- **Codex's `developer` message ≠ user content.** It's an embedded system-prompt-ish block the harness writes. Drop it from `query.chat.messages[]` for the user-facing view; keep it on `query.system_prompt` for completeness.
- **Reasoning is encrypted.** We capture `{type: 'thinking', encrypted: true, byte_length: N}` as a placeholder and do *not* try to decrypt. (Codex chose this; we mirror.)
- **`function_call` + `function_call_output` pair by `call_id`.** That's how we attach inputs to outputs. The `event_msg/exec_command_end` for the same `call_id` carries richer data (cwd, parsed_cmd, exit_code) — prefer it when joining.

### 2.6 `turn_context` shape

```json
{"timestamp": "...", "type": "turn_context",
 "payload": {"turn_id": "...", "cwd": "...", "current_date": "2026-04-29", "timezone": "..."}}
```

One per turn, written right after `task_started`. Useful for **per-turn cwd capture** (the user `cd`'d mid-thread changes here, even if `state_5.threads.cwd` doesn't update).

---

## 3. Gateway flushing algorithm

Codex needs **two collectors** running on the same 5-min cadence: a JSONL tailer (identical to the Claude Code algorithm in `ALGORITHM_CLAUDE.md` §3) and a SQLite watermarker (identical in shape to the Cursor algorithm in `ALGORITHM_CURSOR.md` §3, but pointed at a different table).

### 3.1 JSONL tailer — same as Claude Code

For each `~/.codex/sessions/**/rollout-*.jsonl`:

- Per-file byte cursor in `file_cursor` (defined in `ALGORITHM_CLAUDE.md` §3.2).
- Stat → read [offset, EOF) → split-at-last-newline → redact → ship raw bytes.
- Idempotent on `(source='codex', path, inode, byte_range)`.
- Schema drift inside the JSON values does not break the gateway.
- The path glob is the only Codex-specific change. **Date-partitioning means new dates create new directories**; the gateway's `glob` walks them naturally.

### 3.2 SQLite watermarker — same shape as Cursor, different table

For `~/.codex/state_5.sqlite`:

```
1. tmp = "/tmp/proxai-codex-state-<uuid>.db"
2. sqlite3 "file:~/.codex/state_5.sqlite?mode=ro" "VACUUM INTO '<tmp>'"
3. row = SELECT last_max_rowid FROM source_cursor WHERE source='codex' AND db_path=...
   offset = row.last_max_rowid OR 0
4. rows = SELECT rowid, * FROM threads               WHERE rowid > offset
        ∪ SELECT rowid, * FROM thread_dynamic_tools  WHERE rowid > offset_2
        ∪ SELECT rowid, * FROM thread_spawn_edges    WHERE rowid > offset_3
       (one watermark per table, three watermarks total)
5. redact, batch, ship as in §3.4 of ALGORITHM_CURSOR.md
6. on 2xx: advance the three watermarks
```

We pull only the three in-scope tables. A single `redaction-test` unit test (per `DESIGN.md`) enforces that no other tables ever leave the gateway.

### 3.3 The two collectors don't need to be coordinated

The JSONL collector and SQLite collector run independently. They produce different `upload_batch` rows. The backend joins them at parse time on `thread_id` (= `state_5.threads.id` = filename UUID = `session_meta.payload.id`).

If the JSONL arrives before the SQLite snapshot has the matching `threads` row (or vice versa), the parser holds the partial record in a `pending_thread` table and finalizes when the join is complete. Idle-flush threshold: 30 min (same as Claude Code).

### 3.4 Multi-session concurrency

Each Codex CLI invocation creates one rollout JSONL file. Multiple concurrent sessions = multiple files. The per-file cursor in `file_cursor` is independent, so the JSONL collector handles arbitrary concurrency for free — same as Claude Code.

The SQLite is shared across sessions but has only one writer (the Codex daemon / single CLI process for that session). `VACUUM INTO` against a `?mode=ro` connection handles concurrent writes safely.

What we observed on this machine: 3 sessions across 2 days, no overlapping windows. Concurrent multi-session operation is not data-verifiable, but architecturally it's the same shape as Claude Code (per-file JSONL) + Cursor (single SQLite snapshot).

### 3.5 Snapshot cost

Live `state_5.sqlite` is 200 KB main + 4 MB WAL on this machine. `VACUUM INTO` produces 200 KB; takes ~5 ms. JSONL files total 1.5 MB; tailing the latest 5 min sees < 50 KB delta.

---

## 4. Backend call-record parsing algorithm

### 4.1 The unit: one `CallRecord` per `turn_id`

A `turn_id` (from `event_msg/task_started`) bounds one user→assistant turn. Within that bracket:
- 1 user input (mirrored as `event_msg/user_message` and as `response_item/message[role=user]`)
- N reasoning blocks (`response_item/reasoning`)
- M assistant text blocks (`response_item/message[role=assistant]` and `event_msg/agent_message`)
- K tool-call cycles (`response_item/function_call` paired with `function_call_output` and possibly `event_msg/exec_command_end` for richer data)
- Possibly web searches (`response_item/web_search_call` + `event_msg/web_search_end`)

We collapse all of them into one `CallRecord`:

```yaml
CallRecord:
  client_app: codex
  client_app_version: <state_5.threads.cli_version>
  client_session_id: <thread.id>
  client_turn_id: <turn_id from task_started>
  parent_turn_id: <prior turn_id in same thread, or null on first turn>

  query:
    chat:
      messages: [<this turn's user message — payload.message from user_message OR
                  response_item/message[role=user]>]
      system_prompt: <session_meta.base_instructions.text>     # captured once per thread
    provider_model:
      provider: <state_5.threads.model_provider>               # 'openai' (direct ✓)
      model:    <state_5.threads.model>                        # 'gpt-5.5' (direct ✓)
    tools: <list from state_5.thread_dynamic_tools + observed function_call.name values>
    cwd: <turn_context.cwd if present, else state_5.threads.cwd>
    sandbox_policy: <state_5.threads.sandbox_policy>
    approval_mode:  <state_5.threads.approval_mode>
    reasoning_effort: <state_5.threads.reasoning_effort>       # → ThinkingType {low,medium,high}

  result:
    content:
      [<reasoning blocks — `{kind: thinking, encrypted: true, byte_length: N}`>,
       <assistant text blocks>,
       <tool_use blocks — {name, args, call_id}>,
       <tool_result blocks — {call_id, output, exit_code (from exec_command_end), …}>,
       <web_search blocks — {queries[]}>,
       in rollout-line order]
    usage:
      input_tokens: null                          # see §5.3 — Codex does not expose per-turn
      output_tokens: null
      thread_cumulative_tokens_used:              # captured for thread-level rollups (authoritative)
        <state_5.threads.tokens_used at the time of this turn's task_complete>
      estimated_input_tokens:  <tiktoken approximation>
      estimated_output_tokens: <tiktoken approximation>
      tokens_are_estimated_per_turn: true
    timestamp:
      start_utc_date: <task_started.started_at>
      end_utc_date:   <task_complete.completed_at>
      response_time_ms: <task_complete.duration_ms>            # direct ✓
      time_to_first_token_ms: <task_complete.time_to_first_token_ms>   # direct ✓ (best of three)
    tool_summary: <Counter of function_call.name + 'web_search' if any>

  capture:
    source: codex
    path: <rollout_path>
    record_ref: <turn_id>
    schema_version: <cli_version>:<rollout-format-version>
```

Why this shape: same as Claude Code (per-turn linked list, no inlined history, parent pointer for full reconstruction). Codex provides the cleanest turn boundary — no inference, no heuristic, no `promptId`-like field that's only sometimes there. We use it directly.

### 4.2 Streaming algorithm

```
state = load_state(thread_id)
        # state.last_emitted_turn_id, state.open_turn_id, state.open_records

threads_meta = load_threads_metadata(thread_id)  # from sidecar SQLite

for line in lines(rollout_jsonl_batch):
    rec = json.loads(line)                         # tolerant; bad line → log and skip
    t = rec['type']
    p = rec.get('payload') or {}

    if t == 'session_meta':
        state.session_meta = p                      # cwd, base_instructions, etc.
        continue

    if t == 'event_msg' and p.get('type') == 'task_started':
        if state.open_turn_id is not None:
            yield finalize(state.open_records, parent=state.last_emitted_turn_id)
            state.last_emitted_turn_id = state.open_turn_id
        state.open_turn_id = p['turn_id']
        state.open_records = [rec]
        continue

    if t == 'event_msg' and p.get('type') == 'task_complete':
        state.open_records.append(rec)
        yield finalize(state.open_records, parent=state.last_emitted_turn_id)
        state.last_emitted_turn_id = state.open_turn_id
        state.open_turn_id = None
        state.open_records = []
        continue

    # all other lines (response_item, turn_context, other event_msg subtypes)
    if state.open_turn_id is not None:
        state.open_records.append(rec)
    # else: pre-first-turn lines (rare; usually only session_meta) are kept on
    # state.session_meta and not emitted as a turn.

save_state(thread_id, state)
```

Codex's `task_complete` makes finalization deterministic — we don't need to wait for the *next* turn's `task_started` to know the previous one is done. This is a small win over Claude Code's "see the next promptId to know the previous is complete" rule.

### 4.3 Joining response_items to turns

`response_item` records do **not** carry `turn_id`. We attach them by position: a `response_item` belongs to the most recently opened turn. This is reliable in observed data (rollouts are written in real-time append order; no out-of-order writes).

The `function_call` / `function_call_output` pair is joined by `call_id` within a turn. The same `call_id` may also appear in an `event_msg/exec_command_end` (for shell commands) or `event_msg/web_search_end` (for web searches) — we prefer those richer event_msgs over the bare `function_call_output` when both exist.

### 4.4 Idle-flush, idempotency, multi-thread concurrency

Same rules as `ALGORITHM_CLAUDE.md` §4.3–4.5 (30-min idle threshold, deterministic id from `(client_app, session_id, turn_id)`, per-file scoping for concurrency).

### 4.5 `/resume` and continuation: mirror the source

Codex creates a new rollout file *per CLI invocation*. Resume behavior:

- **CLI re-attach to a live thread.** `codex resume` against an unfinished thread reopens the *same* `thread.id` and (per observation) appends to the *same* rollout file. **Same thread = same chain.** Correct by construction.
- **Cross-CLI-invocation continuation.** `codex resume <thread-id>` after closing reopens the same file. (Verified by file-naming convention: filename embeds thread UUID; reopen would write to the original file, not a new dated path.)
- **Compaction / context overflow.** Codex's stage-1 memory output (`state_5.stage1_outputs`) suggests Codex *does* summarize internally, but in observed data this happens within the same thread — no new thread is forked. We mirror that: same chain.
- **Sub-thread spawn.** `state_5.thread_spawn_edges` carries `(parent_thread_id, child_thread_id)`. **In observed data this table is empty**, so we cannot verify the algorithm. When populated, the child thread gets its own rollout file and its own `CallRecord` chain; the link lives in a separate `parent_thread_id` field on the child's first `CallRecord`. This is **the only place across the three agents where we *do* link across sessions**, because Codex itself does — we mirror Codex's own model.

### 4.6 Why this is enough

- Within a thread: provably correct chain (each turn's parent is the prior turn_id; `task_started`/`task_complete` make boundaries unambiguous).
- Across threads: zero cross-talk (per-file scoping).
- Across sub-thread spawns: linked via `thread_spawn_edges` when populated; mirrors Codex's own model.

For MVP analytics (project tokens, time spent, features), we get the cleanest boundary detection of the three agents and the richest header metadata — but per-turn tokens are missing (§5.3).

---

## 5. Metadata parsing algorithm

### 5.1 Project / cwd / git (MVP-required) — best of the three agents

**Source.** `state_5.threads` row, joined to the rollout via `thread_id`. Fields:
- `cwd` — absolute path, direct.
- `git_sha`, `git_branch`, `git_origin_url` — full provenance, all direct.

**Per-turn refinement.** Within a thread, the user can `cd` (the agent has shell access). The `turn_context.cwd` field reflects the cwd at the time of that turn. We pin per-`CallRecord` from `turn_context.cwd` if present; else from `state_5.threads.cwd`.

**Algorithm.**
```
def derive_project(turn) -> ProjectInfo:
    cwd = turn.turn_context.cwd if turn.turn_context else turn.thread.cwd
    return ProjectInfo(
      key      = realpath(cwd),
      git_sha  = turn.thread.git_sha,         # thread-level (entire session)
      git_branch = turn.thread.git_branch,
      git_origin = turn.thread.git_origin_url,
    )
```

This is the **best `cwd`/git situation of the three agents** (Claude Code: cwd ✓, branch ✓, no sha; Cursor: derive from attachments only). We pass through verbatim.

### 5.2 Resume / continuation

Same composer/thread = same chain (§4.5). For sub-thread spawns, we *do* link: `parent_turn_id` of the child's first turn points to the parent's most-recent turn at spawn time, and `parent_thread_id` is set to the parent's thread_id. Source: `state_5.thread_spawn_edges`. Observed empty on this machine — needs verification when sub-agents are exercised.

### 5.3 Token usage — the same problem as Cursor

**Observed reality:**
- Per-turn tokens: **not in the rollout.** `event_msg/task_complete` carries `duration_ms` and `time_to_first_token_ms`, no token counts. `event_msg/token_count` is misnamed — it carries quota / rate-limit info, not per-turn tokens.
- Thread-cumulative: `state_5.threads.tokens_used` IS populated. Observed values: 1.66M, 364K, 232K for the three threads. **Authoritative**, but only at thread grain.

**MVP strategy.**

| Analytic | Data source |
|---|---|
| **Per-thread / per-day / per-project tokens** | `state_5.threads.tokens_used` — authoritative, no estimation |
| **Per-turn tokens (for "tokens per feature" rollups)** | tiktoken estimate on the turn's content; flagged `tokens_are_estimated_per_turn: true` |
| **Thread-level cost** | `tokens_used × pricing[provider, model, ts]` — exact |
| **Per-turn cost** | Estimate × pricing — `cost_is_estimated: true` flag |

This is a **better situation than Cursor** (where we have *no* authoritative tokens) and **worse than Claude Code** (where every turn has a full usage block including cache breakdowns). For thread-grain analytics — which is what the user's MVP cares about — we have what we need.

### 5.4 Tools (MVP-required)

**Source.** Two:
1. **`state_5.thread_dynamic_tools`** — registered dynamic tools, with `name`, `description`, `input_schema`, `namespace`, `defer_loading`. Observed on this machine: 4 dynamic tools per thread (`automation_update`, `read_thread_terminal`, `load_workspace_dependencies`, `install_workspace_dependencies`). **This does not include built-in tools** like `exec_command`.
2. **`response_item.payload[type='function_call'].name`** — actually-called tool names. The union of these gives the turn's tool inventory.

**Algorithm.**

```
def turn_tools(turn) -> ToolSummary:
    # Built-in + dynamic tools the model COULD have used
    available = thread.thread_dynamic_tools + BUILTIN_TOOLS
    # Tools the model ACTUALLY called this turn
    called = [r.payload.name for r in turn.records if r.type == 'response_item' and r.payload.type == 'function_call']
    return ToolSummary(
      available_count = len(available),
      called          = Counter(called),
      richer_results  = {                    # join by call_id from event_msg
        cid: exec_command_end_event for cid, exec_command_end_event in ...
      },
    )
```

`exec_command_end` carries the full bash result: `command`, `cwd`, `parsed_cmd`, `stdout`, `stderr`, `exit_code`, `duration`. Stash on the corresponding tool_use block. This is **richer than the bare `function_call_output.output`** field — prefer it.

### 5.5 Reasoning / thinking

**Source.** `response_item.payload[type='reasoning']`. **`encrypted_content` is opaque** — we don't decrypt. We capture metadata only:

```yaml
content:
  - kind: thinking
    encrypted: true
    byte_length: <len(encrypted_content)>
    summary: []                               # always empty in observed data
    # No text — Codex does not write the reasoning content in the clear.
```

Because Codex's `reasoning_effort` (low / medium / high) is on the `threads` row, the **effort level is recoverable** even if the reasoning text is not. Maps cleanly to `ThinkingType` per `CALL_RECORD_MAPPING.md`.

### 5.6 Provider / model / pricing (MVP-required)

**Source.** All direct from `state_5.threads`:
- `model_provider` = `'openai'`
- `model` = `'gpt-5.5'`
- `cli_version` = `'0.126.0-alpha.8'`

No inference needed (compare with Cursor §5.5 where we have to prefix-match). Pricing is computed downstream from `(provider, model, tokens_used)` using the same backend table as the other agents.

### 5.7 Sandbox / approval / system prompt (MVP-nice-to-have)

Codex carries operating-envelope metadata that the other agents don't:
- `state_5.threads.sandbox_policy` — JSON: `{type: 'workspace-write', network_access: false, exclude_tmpdir_env_var, exclude_slash_tmp}`. Useful for "what was the agent allowed to do at the time of this call?" Maps to `permission_envelope` — schema gap [G-S9] in `CALL_RECORD_MAPPING.md`.
- `state_5.threads.approval_mode` — `'on-request'`.
- `session_meta.base_instructions.text` — the **full system prompt** Codex sent to the model. Captured once per thread on `query.system_prompt`. **OpenAI may consider this proprietary**; we capture it because it's user-readable on disk and the user already has it. Surface in the dashboard with a "this is Codex's internal prompt" caveat.

### 5.8 `event_msg/exec_command_end` — richer than ToolContent today

This event carries `cwd`, `parsed_cmd`, full `stdout`, `stderr`, `exit_code`, `duration`. The current `CallRecord.ToolContent` schema doesn't have fields for any of these — gap [G-T2] is open in `CALL_RECORD_MAPPING.md`. For MVP we stash them in `provider_specific.exec_command_end[]` and let the schema catch up.

### 5.9 Codex-specific metadata (deferred past MVP)

- `originator` / `source` — `'Codex Desktop'` / `'vscode'`. Useful for an analytics split (terminal vs. desktop) — maps to schema gap [G-S7]. Pass through, no work.
- `agent_nickname`, `agent_role`, `agent_path` — Codex's multi-persona feature. Pass through.
- `memory_mode` — `'enabled'` / `'disabled'`. Pass through.
- `goals` (`thread_goals` table) — token budgets per thread. Empty in observed data; defer.
- `web_search_call.action.queries[]` — Codex performs multi-query search rewrites. Capture in `tool_use.input.queries` for the web_search call.
- `event_msg/thread_name_updated` — title regeneration. Last one wins for `query.thread_title`.

---

## 6. Worked example

A short turn from the 2026-04-29 session, walked end-to-end. Thread `019dd9ac-600b-7b52-91f4-445718488cec`, "Check thinking support."

**Source (rollout JSONL, lines 6–14, abbreviated):**

```jsonl
{"type":"session_meta","payload":{"id":"019dd9ac-...","cwd":"/Users/osmanaka/repos/proxai/proxai","originator":"Codex Desktop","cli_version":"0.126.0-alpha.8","model_provider":"openai","base_instructions":{"text":"You are Codex, a coding agent…"}}}
{"type":"event_msg","payload":{"type":"task_started","turn_id":"019dd9ac-74d7-…","started_at":1777473451,"model_context_window":258400}}
{"type":"turn_context","payload":{"turn_id":"019dd9ac-74d7-…","cwd":"/Users/osmanaka/repos/proxai/proxai","current_date":"2026-04-29"}}
{"type":"event_msg","payload":{"type":"user_message","message":"Are supporting thinking??\n"}}
{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Are supporting thinking??\n"}]}}
{"type":"response_item","payload":{"type":"reasoning","summary":[],"content":null,"encrypted_content":"gAAAAA…"}}
{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Yes, I can help with thinking through problems…"}]}}
{"type":"event_msg","payload":{"type":"agent_message","message":"Yes, I can help with thinking through problems…","phase":"final_answer"}}
{"type":"event_msg","payload":{"type":"task_complete","turn_id":"019dd9ac-74d7-…","completed_at":1777473454,"duration_ms":2903,"time_to_first_token_ms":2078,"last_agent_message":"Yes, I can help…"}}
```

**Source (sidecar SQLite):**

```sql
SELECT * FROM threads WHERE id = '019dd9ac-600b-7b52-91f4-445718488cec';
-- id=019dd9ac-...  rollout_path=...  model_provider=openai  model=gpt-5.5
-- cwd=/Users/osmanaka/repos/proxai/proxai  git_branch=main  git_sha=88cdf90...
-- sandbox_policy={"type":"workspace-write",…}  approval_mode=on-request
-- reasoning_effort=medium  cli_version=0.126.0-alpha.8  tokens_used=363741
```

**Gateway flush (5 min cycle):**
- JSONL collector: rollout grew by ~1.5 KB this slice. `stat()` → read → split-at-last-newline → redact → ship.
- SQLite collector: `state_5.threads` had a new row at rowid > offset. `VACUUM INTO` → query → ship.
- Both batches arrive on the backend within seconds of each other.

**Backend parse:**
- SQLite batch: thread row cached with cwd, git, model, etc.
- JSONL batch: `task_started` → open turn `019dd9ac-74d7-…`. Records accumulate. `task_complete` → finalize.

**Resulting `CallRecord`:**

```yaml
client_app: codex
client_app_version: 0.126.0-alpha.8
client_session_id: 019dd9ac-600b-7b52-91f4-445718488cec
client_turn_id: 019dd9ac-74d7-7960-9a6b-2ad183dab98d
parent_turn_id: null                                # first turn in thread
query:
  chat:
    messages: [{ role: user, content: 'Are supporting thinking??\n' }]
    system_prompt: 'You are Codex, a coding agent…'   # base_instructions.text
  provider_model: { provider: openai, model: gpt-5.5 }
  tools: [exec_command, automation_update, read_thread_terminal, load_workspace_dependencies, install_workspace_dependencies]
  cwd: /Users/osmanaka/repos/proxai/proxai
  git: { sha: 88cdf90…, branch: main, origin_url: <captured> }
  sandbox_policy: { type: workspace-write, network_access: false }
  approval_mode: on-request
  reasoning_effort: medium
result:
  content:
    - { kind: thinking, encrypted: true, byte_length: 1024 }
    - { kind: text, text: 'Yes, I can help with thinking through problems…' }
  usage:
    input_tokens: null
    output_tokens: null
    estimated_input_tokens: 9          # tiktoken on user prompt
    estimated_output_tokens: 76
    thread_cumulative_tokens_used: 363741
    tokens_are_estimated_per_turn: true
  timestamp:
    start_utc_date: '2026-04-29T14:37:31.259Z'
    end_utc_date:   '2026-04-29T14:37:34.130Z'
    response_time_ms: 2903
    time_to_first_token_ms: 2078
  tool_summary: {}                     # this turn was a chat-only response, no tools
capture:
  source: codex
  path: ~/.codex/sessions/2026/04/29/rollout-2026-04-29T10-37-25-019dd9ac-…jsonl
  record_ref: 019dd9ac-74d7-7960-9a6b-2ad183dab98d
  schema_version: '0.126.0-alpha.8'
```

This single record answers the user's three MVP questions:
- **Which feature?** Embed `query.chat.messages[0]`; cluster.
- **Time spent?** `result.timestamp.response_time_ms` = 2903 ms. (Plus `time_to_first_token_ms` = 2078 — Codex is the only agent that exposes TTFT.)
- **Project tokens?** Per-turn estimate (9 + 76 = 85 estimated) for fine-grained rollups; thread cumulative (363741) for authoritative thread/day totals.

---

## 7. Data limitations on this machine

What we **did** observe:
- 3 rollouts (97, 110, 218 lines), all 2026-04-28/29.
- Single CLI version, single provider, single model, single reasoning effort, single sandbox policy.
- Three threads with full git provenance and authoritative `tokens_used` totals.
- Reasoning blocks exist with encrypted content; we cannot read them.
- `task_started` / `task_complete` brackets work as expected.
- `function_call` / `function_call_output` / `event_msg/exec_command_end` triplet observed.
- `web_search_call` / `web_search_end` observed.

What we **could not verify** from this sample, and how to close each before MVP code-freeze:

| Gap | Why it matters | How to verify |
|---|---|---|
| Sub-thread spawn shape (`thread_spawn_edges`) | §4.5 / §5.2 assume the table populates with `(parent, child, status)` rows when Codex spawns a sub-agent. Empty in observed data. | Run a Codex agent-spawn task and snapshot. |
| `agent_jobs` / `agent_job_items` (batch agent runs) | These tables exist; behavior unverified. May contain user content. | Run a batch agent job, inspect contents, decide whether to capture or skip. Skip-list `agent_job_items.row_json` and `result_json` for now. |
| `stage1_outputs` (Codex internal memory) | Empty in observed data. Probably contains memory summaries / rollout summaries. **Privacy-sensitive** if it carries verbatim user content. | Inspect populated rows; default to skip until we know. |
| Cross-CLI-invocation resume behavior | §4.5 assumes `codex resume` reopens the original rollout file. | `codex resume <thread-id>` after closing; check whether a new rollout file is created or the old one is appended. |
| Multi-session concurrency | Architecturally per-file like Claude Code; not data-verified. | Run two `codex` processes in parallel, check that two distinct rollout files appear and SQLite has two new rows. |
| Provider-other-than-OpenAI sessions | `model_provider` is always `openai` in observed data. | Configure Codex with an Anthropic / Gemini / DeepSeek backend (it supports them) and observe field values. |
| Reasoning encryption key location | Encrypted reasoning has the same length signature across blocks (~1 KB); presumably one key per thread/session, possibly stored in `auth.json` or local keychain. **We do NOT need to decrypt for MVP**; flagged for completeness. | Out of scope for this doc. |
| `event_msg/token_count.info` populated case | `info` is `null` in observed data. The field name suggests it *can* carry token info. | Run a longer thread to see if `info` ever populates with structured token data. |
| `goals` / `agent_nickname` / `memory_mode='disabled'` modes | All single-value in observed data. | Run with each variant. |

The right way to close most of these is the **fixture-generation script** mentioned in `ALGORITHM_CURSOR.md` §10.4 — extend it to drive Codex through scripted tasks (sub-agent spawn, batch run, multi-provider, memory-disabled).

---

## 8. MVP scope recap

The user's stated MVP analytics: *which features users are working on, how much time they're spending, which project consumes what amount of tokens.*

| Algorithm | MVP need | Source |
|---|---|---|
| Flushing — JSONL tail (§3.1) | All of it | Same as Claude Code |
| Flushing — SQLite snapshot (§3.2) | All of it | This doc |
| Per-turn `CallRecord` parsing (§4.1–4.4) | All of it | This doc |
| Cross-thread spawn linkage (§4.5 / §5.2) | Required when populated | `thread_spawn_edges` direct |
| Project / cwd / git (§5.1) | Required | Direct from `threads` |
| Token usage — thread cumulative (§5.3) | Required (authoritative) | `threads.tokens_used` |
| Token usage — per-turn estimate (§5.3) | Required (estimated) | tiktoken |
| Tools (§5.4) | Required | `thread_dynamic_tools` + `function_call.name` |
| Provider / model (§5.6) | Required | Direct |
| Pricing (§5.6) | Required | Backend table × tokens_used |
| Reasoning metadata (§5.5) | Nice | Encrypted; metadata only |
| Sandbox / approval / system prompt (§5.7) | Nice | Direct from `threads` + `session_meta` |
| `exec_command_end` rich data (§5.8) | Nice | Stash in `provider_specific` |
| Codex-specific metadata (§5.9) | Skip | Pass-through; defer surfacing in dashboard |
| Sub-thread spawns | Skip until populated | Empty in data; covered by §4.5 when active |

Everything in "skip" is non-destructive — raw bytes are preserved on the backend, so any of these can be promoted by re-running the parser without recapture.

---

## 9. Open questions

1. **System-prompt capture policy.** `session_meta.base_instructions.text` is OpenAI's Codex prompt verbatim. The user *can* read it on their disk, so capturing it is not a new exposure. But shipping it to the ProxAI backend creates a copy in our infrastructure. Recommend: capture but **never display in the dashboard** unless the user explicitly opens a "raw" view. Add a toggle in §3 redaction config.
2. **`agent_jobs.input_csv_path` / `output_csv_path`.** These point at user-side CSV files. Do we follow the references and ship the CSVs? Recommend: **no** for MVP. The agent_job_items rows already carry `row_json` with the actual content.
3. **`stage1_outputs.raw_memory` and `rollout_summary`.** Codex-generated summaries of past sessions, used for cross-session memory. Capture or skip? Recommend: **skip for MVP** — they're regeneration artifacts, not source-of-truth.
4. **Reasoning encryption.** Should we attempt to decrypt? Recommend: **no**. The user can already see the reasoning summary in the Codex UI; surfacing it from disk requires reverse-engineering Codex's encryption, which is fragile and a privacy escalation.
5. **Idle-flush threshold.** 30 min same as the other two. Codex's `task_complete` fires reliably (we saw it 3/3 times), so idle-flush should rarely engage.

---

## 10. Next steps

1. Update `CAPTURE_TARGETS.md` Codex section to add `thread_dynamic_tools` and `thread_spawn_edges` to the "read" list (currently lists `threads` only). Add the explicit skip-list entries for `agent_jobs`, `agent_job_items`, `jobs`, `backfill_state`, `stage1_outputs`, `thread_goals`, `device_key_bindings`, `remote_control_enrollments`, `_sqlx_migrations`.
2. Implement the JSONL tailer for Codex. Same code as Claude Code's `jsonl_tail.ts` with a Codex-specific path glob; lives in `packages/gateway/src/collectors/codex_jsonl.ts`.
3. Implement the SQLite watermarker for Codex. Shares the snapshot+watermark pattern with Cursor's collector but reads three different tables; lives in `packages/gateway/src/collectors/codex_state.ts`.
4. Implement the backend parser. The `task_started` / `task_complete` boundary makes this the cleanest of the three parsers. Lives in `packages/nest-ingest/src/parsers/codex.ts`.
5. Extend the fixture-generation script (started in `ALGORITHM_CURSOR.md` §10.4) with Codex scenarios: sub-agent spawn, multi-provider, batch agent run, longer single-thread session.
6. Validate on the user's existing 3 rollouts before any new fixtures arrive.
