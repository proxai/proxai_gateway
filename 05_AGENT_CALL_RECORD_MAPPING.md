# AgentCallRecord Mapping — Claude Code, Cursor, Codex

**Status:** v0.1 (rewritten alongside the simplified `AgentCallRecord` schema)
**Owner:** ProxAI
**Audience:** backend parser engineers (eventually moves to `proxai_nest`).

> **What this doc is.** A field-by-field recipe for translating the raw bytes the gateway uploads (DTO contract in `03_FLUSHING_ALGORITHM.md` §3) into the typed `AgentCallRecord` (schema in `04_AGENT_CALL_RECORD.md`). Three parsers, one shared schema.
>
> **What this doc is not.** Not the gateway capture algorithm (that's `03`), not the schema definition (that's `04`), not a tutorial on the agents themselves.

---

## 1. The shape in one sentence

For each agent's raw stream, the parser emits **one `AgentCallRecord` per turn** — `<one user input>` + `<every assistant event until the next user input>`. The typed spine is the same across all three agents; per-agent variation lives in `agent_metadata: dict`.

| Agent | Source kind | Turn boundary |
|---|---|---|
| **Claude Code** | append-only JSONL, one file per session | a `promptId` (one user submit + all of its assistant iterations) |
| **Cursor** | SQLite KV snapshot (`cursorDiskKV`) | a `type=1` user bubble + all subsequent `type=2` bubbles up to the next `type=1` |
| **Codex** | append-only JSONL + sidecar SQLite | `event_msg/task_started` to its matching `event_msg/task_complete` |

---

## 2. Common rules

These rules apply to all three parsers. Per-agent specifics start at §3.

### 2.1 The deterministic `id`

```
id = blake2b_128(agent_app.name || '\x1f' || chat.chat_id || '\x1f' || turn.turn_id)
```

base32-encoded. Same source bytes always produce the same `id`; re-uploads upsert. Never invent a UUID.

### 2.2 Status lifecycle (when to emit each)

A record is emitted **only when its turn has a definitive outcome**:

| Status | When |
|---|---|
| `SUCCESS` | The terminator arrived: a *later* `promptId` (Claude Code) / a *later* `type=1` bubble (Cursor) / an `event_msg/task_complete` (Codex). |
| `INCOMPLETE` | The parser-side accumulator buffered the turn for >30 minutes with no new bytes. Synthesized; explanation goes in `agent_metadata['incomplete_reason']`. |
| `FAILED` | The source agent recorded an error within the turn. Rare. Explanation in `agent_metadata['error_message']`. |

There is no `IN_PROGRESS` state — the in-flight phase is parser-internal and never produces a record. See `04_AGENT_CALL_RECORD.md` §2.9.

### 2.3 Token quality flag

`result.usage.tokens_are_estimated` is a single bit:

| Agent | Value | Source for `input_tokens` / `output_tokens` |
|---|:-:|---|
| Claude Code | `false` | `assistant.message.usage.input_tokens` / `output_tokens`, summed across the promptId |
| Cursor | `true` | tiktoken on the turn's user content + assistant content |
| Codex | `true` (per-turn) | tiktoken on the turn's user content + assistant content |

Anthropic-specific cache fields (`cache_creation_input_tokens`, `cache_read_input_tokens`, `service_tier`) are populated only when authoritative (Claude Code only). The Codex thread-grain authoritative total goes to `thread_cumulative_tokens`. See `04_AGENT_CALL_RECORD.md` §2.5.

### 2.4 Sub-agents are embedded, not separate records

When the parent agent spawns a sub-agent, the sub-agent's full event stream goes into the parent record's `result.sub_agents` as a `SubAgentRun`. The flat list with `parent_sub_agent_id` pointers handles arbitrary depth. Token / time / `tool_summary` totals on the parent **include** all sub-agent activity. See `04_AGENT_CALL_RECORD.md` §2.4.

`SubAgentRun.sub_agent_id` is the **spawning tool call's `call_id`** in all three agents — that's the natural shared identifier between the parent's spawn block and the sub-agent's events.

### 2.5 Content block types

`result.content` (and each `SubAgentRun.content`) is a `list[MessageContent]` in chronological order. The block types per the shared schema:

| `MessageContent.type` | Purpose | Per-agent source |
|---|---|---|
| `TEXT` | assistant text output | direct from each agent's text representation |
| `THINKING` | model reasoning trace | direct text (Claude, Cursor) or metadata only with `encrypted=True` (Codex) |
| `TOOL` (`kind=CALL`) | tool invocation | tool_use block; carries `name`, `call_id`, `arguments` |
| `TOOL` (`kind=RESULT`) | tool result | paired with CALL by `call_id`; carries `result`, optional `exit_code` / `result_cwd` / `duration_ms` |
| `IMAGE` / `DOCUMENT` | pasted media | rare in agent capture |

`TOOL` blocks for the spawning Task tool are **regular tool calls** — there's no special kind for sub-agent spawns. The `call_id` matching `SubAgentRun.sub_agent_id` is the only coupling.

### 2.6 Derived fields (parser computes; never written to disk)

- `result.final_text` — the `text` of the last `MessageContent(TEXT)` block in `result.content`. `None` if no TEXT block exists in the turn (rare; see §3.5 / §4.5 / §5.5).
- `result.tool_summary` — `Counter` of `tool_use.name` across `result.content` and all `SubAgentRun.content`.
- `result.usage.cost_nano_usd` — `(input_tokens + cache_creation × 1.25 + cache_read × 0.1 + output_tokens) × pricing[provider, model, ts]`. `None` when `query.provider_model` is `None` (Cursor `default` auto-router).
- `result.timestamp.response_time` — `end_utc_date - start_utc_date`.

### 2.7 Capture provenance

The `capture` group is **filled by the gateway DTO**, not derived from agent bytes. The parser passes it through verbatim:

| `capture.*` | Comes from |
|---|---|
| `source` | DTO `source_app` |
| `source_path` | DTO `source_path` |
| `record_ref` | turn's native id (promptId / `composerId:user_bubbleId` / turn_id) |
| `schema_version` | DTO `agent_schema_version` |
| `captured_at_utc` | DTO `captured_at_utc` |
| `gateway_version` | DTO `gateway_version` |

---

## 3. Claude Code

### 3.1 Source layout

JSONL files at `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` (paths in `03_FLUSHING_ALGORITHM.md` §5.1). Each line is one source record. Records relevant to a turn share a `promptId`.

Sub-agents live in `<session-dir>/subagents/agent-*.jsonl`. Externalized tool results live in `<session-dir>/tool-results/<hash>.txt`. The gateway uploads each file as a separate `jsonl_append` source; the parser joins them at parse time.

### 3.2 Turn boundary

One `promptId` → one `AgentCallRecord`. Records that count toward a turn:

- 1 `user`-type record (the prompt) carrying `promptId`
- N `assistant`-type records sharing that `promptId`
- M `user`-type records carrying `tool_result` content blocks (paired to assistant `tool_use` blocks)
- Lifecycle records (`attachment`, `permission-mode`, `file-history-snapshot`, `ai-title`, …) interleaved — *some* used for metadata, most ignored

A turn is finalized when a *later* `promptId` appears (or 30-min idle).

### 3.3 Typed-spine field mapping

| `AgentCallRecord` target | Source | How to populate |
|---|---|---|
| `id` | derived | hash per §2.1 |
| `turn.turn_id` | record `promptId` | direct |
| `turn.parent_turn_id` | prior `promptId` in same `sessionId` | walk back through the parsed stream |
| `turn.status` | derived | per §2.2 |
| `chat.chat_id` | record `sessionId` | direct |
| `chat.chat_title` | latest `type=ai-title` record's `aiTitle` | use most recent value seen in stream |
| `chat.created_at_utc` | first record's `timestamp` | ISO-8601 → datetime |
| `agent_app.name` | constant | `CLAUDE_CODE` |
| `agent_app.version` | record `version` | direct (e.g. `'2.1.122'`) |
| `query.user_input.content` | the `user` record's `message.content` | `str` → `[MessageContent(TEXT, text=…)]`; `list[dict]` → translate per content-type |
| `query.user_input.slash_command` | text content | regex `<command-name>(/[a-z]+)</command-name>` → first capture group |
| `query.user_input.attachments` | `attachment` records sharing this `promptId` | translate per `attachment.type` (image / file / `deferred_tools_delta` / etc.) |
| `query.provider_model.provider` | inferred from model name | `claude-*` → `'anthropic'` |
| `query.provider_model.model` | first `assistant` record's `message.model` | direct |
| `result.content` (TEXT) | `assistant.message.content[type=text]` | `MessageContent(TEXT, text=block.text)` |
| `result.content` (THINKING) | `assistant.message.content[type=thinking]` | `MessageContent(THINKING, text=block.thinking)` (signature ignored) |
| `result.content` (TOOL/CALL) | `assistant.message.content[type=tool_use]` | `MessageContent(TOOL, tool_content=ToolContent(kind=CALL, name=block.name, call_id=block.id, arguments=block.input))` |
| `result.content` (TOOL/RESULT) | `user.message.content[type=tool_result]` (paired by `tool_use_id`) | `ToolContent(kind=RESULT, name=<from CALL>, call_id=block.tool_use_id, result=block.content)` |
| `result.content` (TOOL/RESULT) — externalized | `tool-results/<hash>.txt` (separate gateway upload) | join by hash; `result_truncated=True` if size > 4 KB cap |
| `result.sub_agents` | each `subagents/agent-*.jsonl` parsed as inner stream | one `SubAgentRun` per spawning Task tool_use; `sub_agent_id` = the Task call_id |
| `result.final_text` | derived | per §2.6 |
| `result.tool_summary` | derived | per §2.6 |
| `result.stop_reason` | last `assistant.message.stop_reason` | direct (e.g. `'end_turn'`, `'tool_use'`) |
| `result.usage.input_tokens` | sum `assistant.message.usage.input_tokens` over the turn | direct sum |
| `result.usage.output_tokens` | sum `assistant.message.usage.output_tokens` | direct sum |
| `result.usage.tokens_are_estimated` | constant | `False` |
| `result.usage.cache_creation_input_tokens` | sum `assistant.message.usage.cache_creation_input_tokens` | direct sum |
| `result.usage.cache_read_input_tokens` | sum `assistant.message.usage.cache_read_input_tokens` | direct sum |
| `result.usage.service_tier` | last `assistant.message.usage.service_tier` | direct |
| `result.usage.thread_cumulative_tokens` | not available | `None` |
| `result.usage.cost_nano_usd` | derived | per §2.6 |
| `result.timestamp.start_utc_date` | first record's `timestamp` | direct |
| `result.timestamp.end_utc_date` | last record's `timestamp` | direct |
| `result.timestamp.response_time` | derived | `end - start` |
| `result.timestamp.time_to_first_token_ms` | not available | `None` |
| `capture.*` | DTO | per §2.7 |

### 3.4 `agent_metadata` keys

```python
agent_metadata = {
    "cwd": "<record cwd>",                           # per-record; can change mid-chat
    "git_branch": "<record gitBranch>",
    "permission_mode": "<record permissionMode>",
    "entrypoint": "<record entrypoint>",             # 'cli'
    "user_type": "<record userType>",                # 'external'
    "is_archived": False,                            # if known; else omit
    # Anthropic cache detail beyond the typed fields:
    "ephemeral_5m_input_tokens": "<sum>",
    "ephemeral_1h_input_tokens": "<sum>",
    # Tool inventory deltas (if collected):
    "tool_inventory": ["Read", "Edit", "Bash", ...],
}
```

Free to add: any record-level field the parser sees that isn't promoted to the typed spine. Per `04_AGENT_CALL_RECORD.md` §2.7, adding keys is non-breaking.

### 3.5 Notes & edge cases

- **`system` records with `isMeta=true`** are session lifecycle markers (compaction summary, etc.), not user-facing system prompts. **Ignore for content.** They are NOT user input either; do not include in `query.user_input.content`.
- **`parentUuid → uuid` chain at the source is internal record-level linkage**, not turn-level. We collapse to `promptId`; the chain is informational only.
- **Auto-compaction creates a new `sessionId`** with a synthetic first user prompt starting `"This session is being continued from a previous conversation..."`. We **mirror Claude's behavior**: that's a new chat, no cross-chat linking. The synthetic prompt lives in `query.user_input.content` like any other user message.
- **~95% of turns end with a TEXT block** (verified across 525 observed turns). The remaining ~3% end with a `tool_use` (no closing summary); `final_text` is `None` for those — dashboard falls back to `tool_summary` per `04_AGENT_CALL_RECORD.md` §8.1.
- **`stop_reason` values observed**: `end_turn`, `tool_use`, `max_tokens`. Pass through verbatim.
- **`requestId`** is per-API-call (potentially multiple per turn if the SDK retried). Don't promote; if useful, list them in `agent_metadata['request_ids']`.

---

## 4. Cursor

### 4.1 Source layout

SQLite KV at `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`, table `cursorDiskKV`. Two key prefixes matter:

- `composerData:<composerId>` — conversation header. Carries `name`, `unifiedMode`, `forceMode`, `modelConfig`, `fullConversationHeadersOnly` (the bubble manifest), `status`, etc.
- `bubbleId:<composerId>:<bubbleId>` — individual messages. Carries `text`, `richText`, `thinking`, `toolFormerData`, `createdAt`, `context`.

The gateway uploads these as `sqlite_kv_snapshot` batches; each batch is a JSON array of `{rowid, key, value}` rows. **All conversation data is in the global DB**; workspace-scoped DBs have no `cursorDiskKV` rows.

### 4.2 Turn boundary

Walk `composerData.fullConversationHeadersOnly` in order. Each entry is `{bubbleId, type}` where `type=1` is user, `type=2` is assistant. **A turn = one `type=1` bubble + all subsequent `type=2` bubbles until the next `type=1`.**

The composer's `status` field marks completion: `'completed'` means the entire conversation is done; `'none'` means an empty draft (no bubbles, ignore).

### 4.3 Typed-spine field mapping

| `AgentCallRecord` target | Source | How to populate |
|---|---|---|
| `id` | derived | hash per §2.1 |
| `turn.turn_id` | the user-bubble's `bubbleId` | direct (use as turn id since `requestId` is unreliable — empty in 84/89 observed bubbles) |
| `turn.parent_turn_id` | prior user-bubble's `bubbleId` | walk back through the manifest |
| `turn.status` | derived | per §2.2 |
| `chat.chat_id` | the `composerId` | direct |
| `chat.chat_title` | `composerData.name` | direct (auto-generated) |
| `chat.created_at_utc` | first user-bubble's `createdAt` | direct |
| `agent_app.name` | constant | `CURSOR` |
| `agent_app.version` | `composerData._v` + `':'` + bubble `_v` | combined (e.g. `'13:3'`) |
| `query.user_input.content` | user-bubble `text` | `[MessageContent(TEXT, text=bubble.text)]`; pasted images go as IMAGE blocks |
| `query.user_input.slash_command` | not present in Cursor | `None` |
| `query.user_input.attachments` | `bubble.context.{selections, commits, pullRequests, terminalSelections, browserSelections, …}` | translate per kind to `AttachmentRef` |
| `query.provider_model.provider` | inferred from model name | `claude-*` → `'anthropic'`, `gpt-*` → `'openai'`, `'default'` → `None` |
| `query.provider_model.model` | `composerData.modelConfig.modelName` | direct |
| `result.content` (TEXT) | assistant bubbles with non-empty `text` | `MessageContent(TEXT, text=bubble.text)` |
| `result.content` (THINKING) | bubbles with `thinking.text` | `MessageContent(THINKING, text=bubble.thinking.text)` |
| `result.content` (TOOL/CALL) | bubbles with `toolFormerData` | `ToolContent(kind=CALL, name=tfd.name, call_id=tfd.toolCallId, arguments=parse_json(tfd.rawArgs))` |
| `result.content` (TOOL/RESULT) | bubbles with `toolFormerData` (Cursor merges call+result on one bubble) | emit a paired RESULT block from `tfd.result` and `tfd.status` |
| `result.sub_agents` | bubbles in `composerData.subComposerIds` / `subagentComposerIds` | one `SubAgentRun` per sub-composer; `sub_agent_id` = the spawning toolCallId |
| `result.final_text` | derived | per §2.6 |
| `result.tool_summary` | derived | per §2.6 |
| `result.stop_reason` | not directly recorded | `None` |
| `result.usage.input_tokens` | tiktoken estimate over `query.user_input.content` | tokenize text |
| `result.usage.output_tokens` | tiktoken estimate over assistant TEXT/THINKING blocks | tokenize text |
| `result.usage.tokens_are_estimated` | constant | `True` |
| `result.usage.cache_creation_input_tokens` / `cache_read_input_tokens` / `service_tier` | not exposed | `None` |
| `result.usage.thread_cumulative_tokens` | not available | `None` |
| `result.usage.cost_nano_usd` | derived | `None` if `provider_model is None`; else per §2.6 (with `cost_is_estimated` semantics inherited from `tokens_are_estimated`) |
| `result.timestamp.start_utc_date` | user-bubble `createdAt` | direct |
| `result.timestamp.end_utc_date` | last assistant-bubble `createdAt` before next user bubble | direct |
| `result.timestamp.response_time` | derived | `end - start` |
| `result.timestamp.time_to_first_token_ms` | not available | `None` |
| `capture.*` | DTO | per §2.7 |

### 4.4 `agent_metadata` keys

```python
agent_metadata = {
    "cwd": "<derived from selection.uri.fsPath>",     # see §4.5; can vary per turn
    "agent_mode": "<composerData.unifiedMode>",        # 'agent' | 'chat'
    "force_mode": "<composerData.forceMode>",          # 'edit' | 'chat'
    "context_usage_percent": <composerData.contextUsagePercent>,
    "subtitle": "<composerData.subtitle>",             # auto-generated activity summary
    "agent_backend": "<composerData.agentBackend>",
    "lines_added": <composerData.totalLinesAdded>,
    "lines_removed": <composerData.totalLinesRemoved>,
    "files_changed_count": <composerData.filesChangedCount>,
    "_v": "<composerData._v>:<bubble._v>",
    # Optional round-trip:
    "user_input_rich_text": <user_bubble.richText>,    # Cursor lexical-format JSON
    "tool_inventory": [<observed function_call.name values>],
}
```

### 4.5 Notes & edge cases

- **No `cwd` field anywhere.** Derive from `bubble.context.selections[0].uri.fsPath` (or any other path-bearing attachment). Walk up to the nearest `.git` directory for project root if needed. If no path attachments exist, `agent_metadata['cwd'] = None` is acceptable.
- **`tokenCount: {0, 0}` is universal.** All observed bubbles have zero token counts. `tokens_are_estimated=True` and tiktoken is the only path. Document accuracy bound: ±30–80% vs ground truth.
- **`provider_model = None` when `modelName == 'default'`** — Cursor's auto-router. Cost is `None`. Dashboard shows "Cursor (auto-routed)."
- **`agentKv:blob:<sha256>` rows in the source DB are skipped by the gateway** (per `03_FLUSHING_ALGORITHM.md` §6.3). They contain a content-addressed cache of provider-format messages; redundant with bubble content, would 5–10× storage. Don't try to consume them.
- **`composerData.status == 'none'`** = empty draft. Skip; emit no record.
- **Sub-composers (`subComposerIds`, `subagentComposerIds`)** were empty in observed data. When populated, follow §2.4. Each sub-composer is its own composerData + bubble set in the same global DB; parser walks them recursively, flattens grandchildren upward via `parent_sub_agent_id`.
- **Multi-repo turns**: a single user prompt can reference files from multiple repos. Pick the most-frequently-referenced repo for `agent_metadata['cwd']`; record secondary repos in `agent_metadata['secondary_cwds']`.

---

## 5. Codex

### 5.1 Source layout

Two sources, joined by `thread_id`:

- **JSONL rollouts** at `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ISO>-<thread-uuid>.jsonl`. Each line: `{timestamp, type, payload}`. Top-level types: `session_meta` (1 per file, first), `turn_context`, `event_msg`, `response_item`.
- **Sidecar SQLite** `~/.codex/state_*.sqlite`. Three tables in scope: `threads` (per-thread metadata), `thread_dynamic_tools` (tool inventory), `thread_spawn_edges` (parent → child for sub-agent spawns).

The gateway uploads JSONL as `jsonl_append` and the SQLite tables as `sqlite_table_snapshot`. The parser joins them by `thread_id` (= filename UUID = `session_meta.payload.id` = `state.threads.id`).

### 5.2 Turn boundary

Bracketed by event_msg events:

- **Open** on `event_msg/task_started.payload.turn_id`. Buffer subsequent records in this turn.
- **Close** on `event_msg/task_complete.payload.turn_id` (matching id). Emit `AgentCallRecord` with `status=SUCCESS`.

`response_item` records do **not** carry `turn_id`. Attach them to the most recently opened turn (records are chronologically ordered in the rollout file).

### 5.3 Typed-spine field mapping

The threads-table values mostly populate `agent_metadata` (since they're agent-environment, not content); the typed spine is filled mainly from the rollout.

| `AgentCallRecord` target | Source | How to populate |
|---|---|---|
| `id` | derived | hash per §2.1 |
| `turn.turn_id` | `event_msg/task_started.payload.turn_id` | direct |
| `turn.parent_turn_id` | prior `task_started.turn_id` in same thread | walk back |
| `turn.status` | derived | per §2.2 |
| `chat.chat_id` | `threads.id` (= rollout filename UUID = `session_meta.payload.id`) | direct |
| `chat.chat_title` | `threads.title` | direct (auto-generated; updated via `event_msg/thread_name_updated`) |
| `chat.created_at_utc` | `threads.created_at` (or `created_at_ms`) | direct |
| `agent_app.name` | constant | `CODEX` |
| `agent_app.version` | `threads.cli_version` | direct |
| `query.user_input.content` | `event_msg/user_message.payload.message` (preferred) or `response_item/message[role=user].content[].text` | text → `[MessageContent(TEXT)]`; rare images → `IMAGE` blocks |
| `query.user_input.slash_command` | parse from text (Codex doesn't structure these) | `None` typically |
| `query.user_input.attachments` | `event_msg/user_message.payload.images` (rare) | translate to `AttachmentRef(IMAGE)` |
| `query.provider_model.provider` | `threads.model_provider` | direct (e.g. `'openai'`) |
| `query.provider_model.model` | `threads.model` | direct (e.g. `'gpt-5.5'`) |
| `result.content` (TEXT) | `response_item/message[role=assistant].content[type=output_text].text` and/or `event_msg/agent_message.payload.message` | direct (the two views agree; prefer response_item for canonical, but `event_msg/task_complete.last_agent_message` matches the last TEXT exactly) |
| `result.content` (THINKING) | `response_item/reasoning` | `MessageContent(THINKING, encrypted=True, byte_length=len(encrypted_content), text=None)` — opaque blob, no decryption |
| `result.content` (TOOL/CALL) | `response_item/function_call` | `ToolContent(kind=CALL, name=fc.name, call_id=fc.call_id, arguments=parse_json(fc.arguments))` |
| `result.content` (TOOL/RESULT) | `response_item/function_call_output` paired by `call_id`; enrich from `event_msg/exec_command_end` if same `call_id` | `ToolContent(kind=RESULT, name=<from CALL>, call_id, result, exit_code, result_cwd, duration_ms)` |
| `result.content` (web_search) | `response_item/web_search_call` | `ToolContent(kind=CALL, name='web_search', arguments={'queries': action.queries})` |
| `result.sub_agents` | each child rollout file linked via `thread_spawn_edges.child_thread_id` | one `SubAgentRun` per child thread; `sub_agent_id` = the spawning function_call's `call_id` |
| `result.final_text` | derived | per §2.6 (matches `task_complete.last_agent_message` byte-for-byte in observed data) |
| `result.tool_summary` | derived | per §2.6 |
| `result.stop_reason` | not directly recorded | `None` |
| `result.usage.input_tokens` | tiktoken estimate | tokenize text |
| `result.usage.output_tokens` | tiktoken estimate | tokenize text |
| `result.usage.tokens_are_estimated` | constant | `True` (per-turn) |
| `result.usage.cache_*_tokens` / `service_tier` | not exposed | `None` |
| `result.usage.thread_cumulative_tokens` | `threads.tokens_used` snapshot at `task_complete` | direct (authoritative, thread-grain) |
| `result.usage.cost_nano_usd` | derived | per §2.6 |
| `result.timestamp.start_utc_date` | `event_msg/task_started.payload.started_at` (epoch seconds) | direct |
| `result.timestamp.end_utc_date` | `event_msg/task_complete.payload.completed_at` | direct |
| `result.timestamp.response_time` | `event_msg/task_complete.payload.duration_ms` | direct (ms → timedelta) |
| `result.timestamp.time_to_first_token_ms` | `event_msg/task_complete.payload.time_to_first_token_ms` | direct (✓ Codex only — none of the others expose this) |
| `capture.*` | DTO | per §2.7 |

### 5.4 `agent_metadata` keys

```python
agent_metadata = {
    "cwd": "<turn_context.payload.cwd if present else threads.cwd>",   # per-turn override
    "git_sha": "<threads.git_sha>",
    "git_branch": "<threads.git_branch>",
    "git_origin_url": "<threads.git_origin_url>",
    "sandbox_policy": <threads.sandbox_policy_dict>,
    "approval_mode": "<threads.approval_mode>",
    "reasoning_effort": "<threads.reasoning_effort>",                  # 'low' | 'medium' | 'high'
    "originator": "<session_meta.payload.originator>",                 # 'Codex Desktop'
    "source": "<threads.source>",                                       # 'vscode'
    "system_prompt": "<session_meta.payload.base_instructions.text>",  # large; Codex personality + permissions
    "encrypted_thinking_byte_length": <sum across reasoning blocks this turn>,
    "model_context_window": <event_msg/task_started.payload.model_context_window>,
    "collaboration_mode_kind": "<event_msg/task_started.payload.collaboration_mode_kind>",
    "tool_inventory": [
        {"name": "exec_command", "is_dynamic": False},
        {"name": "<each thread_dynamic_tools.name>", "is_dynamic": True, "namespace": "...", "description": "..."},
        # Plus observed function_call.name values not in thread_dynamic_tools
    ],
    "agent_nickname": "<threads.agent_nickname>",
    "agent_role": "<threads.agent_role>",
    "memory_mode": "<threads.memory_mode>",
}
```

### 5.5 Notes & edge cases

- **`response_item.role == 'developer'`** is Codex's internal sandbox/permissions instruction block — *not* user input. Skip from `query.user_input.content`. The full content (including permissions instructions) is part of `agent_metadata['system_prompt']` indirectly via `base_instructions.text`.
- **Reasoning is encrypted.** `response_item/reasoning.encrypted_content` is opaque; we never decrypt. The `MessageContent(THINKING, encrypted=True, byte_length=...)` block records that reasoning happened and how much, nothing more. `agent_metadata['reasoning_effort']` records the configured effort level.
- **`event_msg/token_count`** is misleadingly named — it carries quota / rate-limit info, NOT per-turn tokens. Ignore.
- **`event_msg/exec_command_end`** is the rich version of a tool result for shell commands. It carries `cwd`, `parsed_cmd`, full `stdout`/`stderr`, `exit_code`, `duration`. Prefer it over `function_call_output` when both exist for the same `call_id` — promote `exit_code`, `result_cwd`, `duration_ms` to the `ToolContent` typed fields; stash extras in `agent_metadata` if useful.
- **`stage1_outputs` table is privacy-sensitive** (Codex internal memory summaries). Gateway skips it; parser never sees it.
- **`thread_spawn_edges` was empty in observed data.** Sub-agent embedding is forward-compatible scaffolding; verify when first exercised.
- **CLI version upgrade mid-thread is rare but possible.** `agent_app.version` is the version on the latest record we saw. If a thread was started under v0.125 and continued under v0.126, the parser sees the latter.

---

## 6. Worked example — Codex turn

Showing the most complex case (rollout JSONL + sidecar SQLite join + encrypted reasoning + bash exec).

### 6.1 Source bytes

**Rollout JSONL (excerpt):**
```jsonl
{"timestamp":"2026-04-29T14:37:31.258Z","type":"session_meta","payload":{"id":"019dd9ac-600b-7b52-91f4-445718488cec","cwd":"/Users/.../proxai","originator":"Codex Desktop","cli_version":"0.126.0-alpha.8","model_provider":"openai","base_instructions":{"text":"You are Codex, a coding agent..."}}}
{"timestamp":"2026-04-29T14:37:31.259Z","type":"event_msg","payload":{"type":"task_started","turn_id":"019dd9ac-d822-7992-a311-db298dd37939","started_at":1777473451,"model_context_window":258400}}
{"timestamp":"2026-04-29T14:37:31.260Z","type":"turn_context","payload":{"turn_id":"019dd9ac-d822-7992-a311-db298dd37939","cwd":"/Users/.../proxai"}}
{"timestamp":"2026-04-29T14:37:31.261Z","type":"event_msg","payload":{"type":"user_message","message":"Inspect provider list"}}
{"timestamp":"2026-04-29T14:37:32.000Z","type":"response_item","payload":{"type":"reasoning","encrypted_content":"gAAAAA...(1024 bytes)"}}
{"timestamp":"2026-04-29T14:37:33.000Z","type":"response_item","payload":{"type":"function_call","name":"exec_command","call_id":"call_fztvKvJsPRt027TqYdT75DPT","arguments":"{\"command\":[\"/bin/zsh\",\"-lc\",\"git status --short\"]}"}}
{"timestamp":"2026-04-29T14:37:33.413Z","type":"event_msg","payload":{"type":"exec_command_end","call_id":"call_fztvKvJsPRt027TqYdT75DPT","cwd":"/Users/.../proxai","stdout":"?? .agents/\n?? AGENTS.md\n","exit_code":0,"duration":{"secs":0,"nanos":413000000}}}
{"timestamp":"2026-04-29T14:37:34.000Z","type":"response_item","payload":{"type":"function_call_output","call_id":"call_fztvKvJsPRt027TqYdT75DPT","output":"?? .agents/\n?? AGENTS.md\n"}}
{"timestamp":"2026-04-29T14:37:55.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Looked at provider docs..."}]}}
{"timestamp":"2026-04-29T14:37:56.000Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"019dd9ac-d822-7992-a311-db298dd37939","completed_at":1777473476,"duration_ms":18000,"time_to_first_token_ms":2078,"last_agent_message":"Looked at provider docs..."}}
```

**Sidecar `threads` row (joined by id):**
```
id=019dd9ac-600b-7b52-91f4-445718488cec, model='gpt-5.5', cwd='/Users/.../proxai',
git_sha='88cdf90...', git_branch='main', git_origin_url='git@github.com:proxai/proxai.git',
sandbox_policy='{"type":"workspace-write","network_access":false}',
approval_mode='on-request', reasoning_effort='medium', tokens_used=363741,
cli_version='0.126.0-alpha.8'
```

### 6.2 Resulting `AgentCallRecord`

```python
AgentCallRecord(
    id="2KX...",
    turn=TurnInfo(
        turn_id="019dd9ac-d822-7992-a311-db298dd37939",
        parent_turn_id="<prior task_started.turn_id>",
        status=TurnStatusType.SUCCESS,
    ),
    chat=ChatStamp(
        chat_id="019dd9ac-600b-7b52-91f4-445718488cec",
        chat_title="Check thinking support",
        created_at_utc=dt.datetime(2026, 4, 29, 14, 37, 25),
    ),
    agent_app=AgentApp(name=AgentAppName.CODEX, version="0.126.0-alpha.8"),
    query=AgentQueryRecord(
        user_input=UserInput(
            content=[MessageContent(type=ContentType.TEXT, text="Inspect provider list")],
            attachments=[],
        ),
        provider_model=ProviderModelType(provider="openai", model="gpt-5.5"),
    ),
    result=AgentResultRecord(
        content=[
            MessageContent(type=ContentType.THINKING, encrypted=True, byte_length=1024),
            MessageContent(type=ContentType.TOOL, tool_content=ToolContent(
                kind=ToolKind.CALL, name="exec_command",
                call_id="call_fztvKvJsPRt027TqYdT75DPT",
                arguments={"command": ["/bin/zsh", "-lc", "git status --short"]},
            )),
            MessageContent(type=ContentType.TOOL, tool_content=ToolContent(
                kind=ToolKind.RESULT, name="exec_command",
                call_id="call_fztvKvJsPRt027TqYdT75DPT",
                result="?? .agents/\n?? AGENTS.md\n",
                exit_code=0, result_cwd="/Users/.../proxai", duration_ms=413,
            )),
            MessageContent(type=ContentType.TEXT, text="Looked at provider docs..."),
        ],
        sub_agents=None,
        final_text="Looked at provider docs...",
        tool_summary={"exec_command": 1},
        usage=AgentUsageType(
            input_tokens=4200, output_tokens=520,           # tiktoken estimate
            tokens_are_estimated=True,
            thread_cumulative_tokens=363741,                 # snapshot from threads.tokens_used
            cost_nano_usd=8_400_000_000,
        ),
        timestamp=AgentTimeStampType(
            start_utc_date=dt.datetime(2026, 4, 29, 14, 37, 31),
            end_utc_date=dt.datetime(2026, 4, 29, 14, 37, 56),
            response_time=dt.timedelta(seconds=18),
            time_to_first_token_ms=2078,
        ),
    ),
    capture=CaptureMetadata(
        source="codex", source_path="~/.codex/sessions/.../rollout-...jsonl",
        record_ref="019dd9ac-d822-7992-a311-db298dd37939",
        schema_version="0.126.0-alpha.8",
        captured_at_utc=dt.datetime(2026, 4, 29, 14, 41),
        gateway_version="@proxai/gateway 0.1.0",
    ),
    agent_metadata={
        "cwd": "/Users/.../proxai",
        "git_sha": "88cdf9014ec036dc714860ae7b43b01140ed7187",
        "git_branch": "main",
        "git_origin_url": "git@github.com:proxai/proxai.git",
        "sandbox_policy": {"type": "workspace-write", "network_access": False},
        "approval_mode": "on-request",
        "reasoning_effort": "medium",
        "originator": "Codex Desktop",
        "source": "vscode",
        "system_prompt": "You are Codex, a coding agent...",
        "encrypted_thinking_byte_length": 1024,
        "model_context_window": 258400,
    },
)
```

`final_text` (`"Looked at provider docs..."`) matches `task_complete.last_agent_message` — Codex's own "the answer" marker. The TOOL result block was enriched with `exit_code` and `result_cwd` from `exec_command_end` rather than the bare `function_call_output`. The reasoning is captured as metadata-only; the encrypted blob is never decrypted.

---

## 7. What we cannot recover from disk

These fields exist on `AgentCallRecord` but are populated `None` for some or all agents because the source data simply isn't there. Documented for honesty:

| Field | Why null |
|---|---|
| `result.usage.input_tokens` (authoritative, per-turn) | Cursor and Codex don't write per-turn token counts to disk. tiktoken estimate is the best we can do. |
| `result.usage.cache_*_tokens`, `service_tier` | Anthropic-specific; only Claude Code populates. |
| `result.timestamp.time_to_first_token_ms` | Only Codex records TTFT. Claude Code and Cursor don't. |
| `result.stop_reason` | Cursor and Codex don't surface it. Claude Code does. |
| Provider when `modelName == 'default'` (Cursor) | Auto-router; we don't know which model was actually used. |
| Reasoning text (Codex) | Encrypted at rest. We capture metadata only. |
| `git_sha` (Claude Code, Cursor) | Only Codex writes it. Claude Code has `gitBranch` only; Cursor has nothing. |

Anything in this list that becomes important for analytics is unrecoverable from local-disk capture. The path to fix: switch capture mode to outbound HTTPS proxy (Phase 2 in `01_INTRO.md` §9), which gives access to provider responses directly. Out of MVP scope.

---

## 8. Where to look next

- For the typed schema definition (every field's type and semantics): `04_AGENT_CALL_RECORD.md`.
- For the gateway-side bytes → DTO contract: `03_FLUSHING_ALGORITHM.md`.
- For the agent app architecture: `01_INTRO.md`.

When this doc moves to `proxai_nest`, only the per-agent recipes (§3, §4, §5) and the worked example (§6) need to travel. §1, §2, §7 are universal context.
