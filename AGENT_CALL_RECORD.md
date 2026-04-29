# AgentCallRecord — Design

Source of truth: this document. Once code lands, the source of truth shifts to `proxai_nest/src/types/agent_call_record.ts` (or the equivalent Python types). Until then, this is the spec.

This is the definitive reference for how an `AgentCallRecord` is shaped, how it relates to the SDK's `CallRecord` (`proxai/src/proxai/types.py`), and how the three coding agents (Claude Code, Cursor, Codex) map onto it. Read this before touching the gateway parsers, the backend ingester, or any analytics that consume agent traffic.

> **Companion docs:** `ALGORITHM_CLAUDE.md`, `ALGORITHM_CURSOR.md`, `ALGORITHM_CODEX.md` (per-agent extraction algorithms); `CALL_RECORD_MAPPING.md` (field-by-field mapping from raw bytes); `DESIGN.md` (gateway architecture).

**The shape in one sentence:** one record per turn (`<user input>` + `<all agent responses until next user input>`), partitioned by `chat_id`, linked back to the prior turn in the same chat by `parent_turn_id`. Cross-agent semantics live in a small typed spine; everything agent-specific lives in a loose `agent_metadata: dict`.

---

## 1. AgentCallRecord structure

```
AgentCallRecord
├── id: str                                    # deterministic hash(agent_app.name, chat.chat_id, turn.turn_id);
│                                              #   same input → same id; enables idempotent upsert.
│
├── turn: TurnInfo
│   ├── turn_id: str                           # native id from source:
│   │                                          #   Claude Code promptId | Cursor user-bubble bubbleId |
│   │                                          #   Codex task_started.turn_id
│   ├── parent_turn_id: str | None             # prior turn in same chat_id; None on first turn
│   └── status: TurnStatusType                 # SUCCESS | INCOMPLETE | FAILED — all terminal, see §2.9
│
├── chat: ChatStamp
│   ├── chat_id: str                           # Claude Code sessionId | Cursor composerId | Codex thread.id
│   ├── chat_title: str | None                 # auto-generated; latest record's value is current
│   └── created_at_utc: datetime               # chat start (stable per chat)
│
├── agent_app: AgentApp
│   ├── name: AgentAppName                     # CLAUDE_CODE | CURSOR | CODEX
│   └── version: str                           # source schema / CLI version (e.g. '2.1.122' / '13:3' / '0.126.0-alpha.8')
│
├── query: AgentQueryRecord
│   ├── user_input: UserInput
│   │   ├── content: list[MessageContent]      # the typed user message — text, pasted images, …
│   │   ├── slash_command: str | None          # Claude Code: '/clear', '/compact', …
│   │   └── attachments: list[AttachmentRef]   # @-mentioned files, commits, PRs, etc. (metadata)
│   └── provider_model: ProviderModelType | None   # null when Cursor 'default' (auto-router)
│
├── result: AgentResultRecord
│   ├── content: list[MessageContent]          # canonical chronological event log:
│   │                                          #   THINKING, TEXT, TOOL(CALL), TOOL(RESULT), IMAGE, …
│   ├── output_text: str | None                # convenience: concatenated assistant TEXT blocks
│   ├── tool_summary: dict[str, int] | None    # Counter of tool names called this turn
│   ├── stop_reason: str | None                # provider-reported termination reason
│   ├── usage: AgentUsageType | None
│   │   ├── input_tokens: int | None           # authoritative (Claude) or tiktoken estimate (Cursor, Codex)
│   │   ├── output_tokens: int | None
│   │   ├── tokens_are_estimated: bool         # true → numbers above are tiktoken
│   │   ├── cache_creation_input_tokens: int | None    # Claude-only (authoritative when present)
│   │   ├── cache_read_input_tokens: int | None        # Claude-only
│   │   ├── service_tier: str | None                   # Claude-only
│   │   ├── thread_cumulative_tokens: int | None       # Codex authoritative thread total
│   │   └── cost_nano_usd: int | None          # tokens × pricing; quality follows tokens_are_estimated
│   └── timestamp: AgentTimeStampType | None
│       ├── start_utc_date: datetime           # turn start
│       ├── end_utc_date: datetime             # turn end (last assistant event)
│       ├── response_time: timedelta           # end - start
│       └── time_to_first_token_ms: int | None # Codex direct (others: None)
│
├── capture: CaptureMetadata                   # provenance — required on every record
│   ├── source: str                            # 'claude-code' | 'cursor' | 'codex'
│   ├── source_path: str                       # JSONL or DB path
│   ├── record_ref: str                        # native record id from source
│   ├── schema_version: str                    # upstream agent's schema version
│   ├── captured_at_utc: datetime              # gateway clock
│   └── gateway_version: str                   # @proxai/gateway release
│
└── agent_metadata: dict                       # loose, agent-specific bag.
                                               # See §1.5 for per-agent illustrative shapes.
                                               # Schema is loose by design — version drift is fine.
```

### 1.1 `MessageContent` — extended for agents

Reuses `proxai.types.MessageContent` (`call_record.md` §1.1) with the same content-type enum (`TEXT`, `THINKING`, `JSON`, `PYDANTIC_INSTANCE`, `IMAGE`, `DOCUMENT`, `AUDIO`, `VIDEO`, `TOOL`).

Two backwards-compatible additions for agents:

| Change | Where | Why |
|---|---|---|
| `THINKING` block gets optional `encrypted: bool` and `byte_length: int \| None` fields | `MessageContent` | Codex reasoning is opaque (`encrypted_content` blob). We capture metadata only — see §2.6. SDK use case never sets these. |
| `TOOL` block's `ToolContent` is extended (see §1.2) | `MessageContent.tool_content` | Coding-agent tool calls carry args, results, exit codes, cwd. Closes [G-T2] in `CALL_RECORD_MAPPING.md`. |

### 1.2 `ToolContent` — extended for agents

```
ToolContent
├── name: str                                  # 'Read', 'Bash', 'read_file_v2', 'exec_command', 'Task', …
├── kind: ToolKind                             # CALL | RESULT
├── citations: list[Citation]                  # web search citations (existing)
│
│   # NEW — populated for kind=CALL
├── call_id: str | None                        # pairs CALL with RESULT within a turn
├── arguments: dict | str | None               # parsed JSON when possible; raw string otherwise
├── arguments_truncated: bool
│
│   # NEW — populated for kind=RESULT
├── result: str | dict | None
├── result_truncated: bool                     # true if externalized to side-storage
├── result_path: str | None                    # gateway-side path when truncated
├── exit_code: int | None                      # shell tool only
├── result_cwd: str | None                     # shell tool only
└── duration_ms: int | None                    # tool execution time
```

Pair calls and results within a turn by `call_id`. **Sub-agent spawns are just regular `kind=CALL` blocks with `name='Task'` (Claude Code) or equivalent.** Nothing structural distinguishes them from any other tool call — see §2.4.

### 1.3 `AttachmentRef` — new

Metadata about things the user @-mentioned or had in context that aren't message content per se.

```
AttachmentRef
├── kind: AttachmentKind                       # FILE_SELECTION | FOLDER | IMAGE | COMMIT |
│                                              #   PULL_REQUEST | TERMINAL | BROWSER_TAB |
│                                              #   CURSOR_RULE | MENTION
├── name: str                                  # display name
├── path: str | None                           # absolute path for filesystem kinds
├── range: dict | None                         # line range for file selections
└── metadata: dict                             # kind-specific extras (commit sha, PR number, …)
```

We **never** inline file or commit *content* into an `AttachmentRef`. Content goes through `MessageContent.IMAGE` / `DOCUMENT` blocks when present.

### 1.4 Enums

```
AgentAppName     : CLAUDE_CODE | CURSOR | CODEX
TurnStatusType   : SUCCESS | INCOMPLETE | FAILED          # all terminal, see §2.9
AttachmentKind   : FILE_SELECTION | FOLDER | IMAGE | COMMIT | PULL_REQUEST |
                   TERMINAL | BROWSER_TAB | CURSOR_RULE | MENTION
ToolKind         : CALL | RESULT
```

Adding a new agent (e.g. Antigravity) means: extend `AgentAppName`, write a parser, no other schema changes.

### 1.5 Per-agent `agent_metadata` examples

These are **illustrative, not a required schema.** Parsers are free to add or omit keys, and the shape can drift across agent versions without invalidating older records — that's the entire point of using a loose dict here. Project resolution and other downstream concerns read `cwd` (and whatever else they want) from this bag at query time, with no schema migration cost.

Convention: when a value exists in the source, populate it under a stable key. The list below is what each agent's parser is **expected to produce when the source provides it.** Parsers may add more.

#### Claude Code

```python
agent_metadata = {
    "cwd": "/Users/osmanaka/repos/proxai/proxai_gateway",   # per-record from source
    "git_branch": "HEAD",                                    # per-record from source
    "permission_mode": "acceptEdits",
    "entrypoint": "cli",
    "is_archived": False,
    "user_type": "external",
    # Anything else from the source line we don't promote elsewhere:
    "ephemeral_5m_input_tokens": 0,
    "ephemeral_1h_input_tokens": 8004,
}
```

#### Cursor

```python
agent_metadata = {
    "cwd": "/Users/osmanaka/repos/proxai/proxai",            # derived from attachment paths
    "agent_mode": "agent",                                    # composerData.unifiedMode
    "force_mode": "edit",                                     # composerData.forceMode
    "context_usage_percent": 15.537,
    "subtitle": "Edited model_connector.py",
    "agent_backend": "cursor-agent",
    "lines_added": 1,
    "lines_removed": 2,
    "files_changed_count": 1,
    "_v": "13:3",
    "tool_inventory": [                                       # observed-call vocabulary, loose list
        "read_file_v2", "ripgrep_raw_search", "edit_file_v2", "web_search",
    ],
    "user_input_rich_text": {"root": {"children": [...]}},   # Cursor lexical-format JSON, for round-trip
}
```

#### Codex

```python
agent_metadata = {
    "cwd": "/Users/osmanaka/repos/proxai/proxai",
    "git_sha": "88cdf9014ec036dc714860ae7b43b01140ed7187",
    "git_branch": "main",
    "git_origin_url": "git@github.com:proxai/proxai.git",
    "sandbox_policy": {
        "type": "workspace-write",
        "network_access": False,
        "exclude_tmpdir_env_var": False,
        "exclude_slash_tmp": False,
    },
    "approval_mode": "on-request",
    "reasoning_effort": "medium",
    "originator": "Codex Desktop",
    "source": "vscode",
    "system_prompt": "You are Codex, a coding agent based on GPT-5...",
    "encrypted_thinking_byte_length": 1918,                   # rollup; details in MessageContent(THINKING) blocks
    "model_context_window": 258400,
    "collaboration_mode_kind": "default",
    "tool_inventory": [                                       # from thread_dynamic_tools + observed function_call.name
        {"name": "exec_command", "is_dynamic": False},
        {"name": "automation_update", "is_dynamic": True},
        {"name": "read_thread_terminal", "is_dynamic": True},
    ],
}
```

Consumers that want a stable cross-agent value (like `cwd`) read `agent_metadata['cwd']` and trust the convention. AI-driven analytics that ingest the whole bag don't care about shape at all — they parse what's there.

---

## 2. Design decisions

These are conventions that cannot be inferred from the type tree alone. They are enforced by the parsers, the backend ingester, and the schema validator.

### 2.1 One `AgentCallRecord` per turn

A turn is `<one user input>` + `<every assistant event until the next user input>`. Concretely:

| Agent | Turn boundary |
|---|---|
| Claude Code | one `promptId` (a user submit + all of its assistant iterations and tool calls) |
| Cursor | one `type=1` user bubble + all subsequent `type=2` bubbles until the next `type=1` |
| Codex | one `event_msg/task_started` to its matching `event_msg/task_complete` |

We never emit multi-turn records, per-event records, or per-thinking-block records. The schema enforces this: a record has exactly one `query.user_input` and one `result.content` list.

### 2.2 Stamp every record. No JOINs, no entities.

Every record carries the full set of metadata stamps it needs to be interpreted on its own. No `chat`, `session`, `project`, or `workspace` entities exist in the database — those are concepts, not tables. The DB has one table, `agent_call_records`, partitioned by `chat_id`.

Within a single chat (one `chat_id`):
- Stable stamps repeat identical values across records (`agent_app.name`, `chat.created_at_utc`, `agent_metadata['cwd']` in the common case, …). Column compression handles the redundancy; the simplicity of `WHERE chat_id = X SELECT *` is worth the duplication.
- Stamps that legitimately vary per turn (`cwd` after a `cd`, `git_sha` after a commit, `permission_mode` after a toggle, `cumulative_tokens` per turn, `tool_inventory` after `deferred_tools_delta`) capture each turn's actual state.

Storage cost of all stamps: ~500 B / record × 1M records ≈ 500 MB nominal — ~1% of total content. Cheap.

`chat_id` is the partition key. **Records from two different chats with similar metadata never accidentally mix** — they're separated by `chat_id`. Apparent stamp changes within one chain reflect real source variation, never chat-mixing.

### 2.3 Linked list via `turn.parent_turn_id` — no inlined chat history

Each record carries `turn.parent_turn_id` pointing to the prior turn in the same `chat_id`. To reconstruct conversation history, walk the chain (§5).

We deliberately do **not** carry inlined chat history on the record. Storage stays O(N) total, not O(N²). The MVP analytics — which features / time spent / project tokens — aggregate over per-turn rows directly; they never need the chain walk.

### 2.4 Sub-agents are independent chats

When an agent spawns a sub-agent (Claude Code Task tool, Codex agent-spawn, Cursor sub-composer):

1. The spawning turn records a regular `MessageContent(TOOL, kind=CALL, name='Task', …)` block in its `result.content`. Nothing structural distinguishes it from any other tool call.
2. The sub-agent's records form their own chain, with their own `chat_id`, walking back through their own `parent_turn_id`s. Independent linked list.

There is no cross-chat schema relation. **The chat is the unit. Period.** If a future feature needs cross-chat threading, the lightweight place to preserve it is in `agent_metadata['spawned_from']` on the child's first record (parser stamps it from `thread_spawn_edges` for Codex or sidechain directory layout for Claude Code). Non-breaking.

### 2.5 Token usage: one population + a quality flag

`AgentUsageType` carries `input_tokens` and `output_tokens` populated with whichever quality is available, distinguished by `tokens_are_estimated`:

| Agent | `tokens_are_estimated` | Source |
|---|:-:|---|
| Claude Code | `false` | provider-reported per turn |
| Cursor | `true` | tiktoken on the turn's content |
| Codex | `true` (per-turn) | tiktoken on the turn's content |

Anthropic-specific cache fields (`cache_creation_input_tokens`, `cache_read_input_tokens`, `service_tier`) are populated only when authoritative — i.e. only for Claude Code. Null for Cursor and Codex.

`thread_cumulative_tokens` (Codex `threads.tokens_used`) is structurally separate. It's an authoritative thread-grain total, not a per-turn estimate; snapshot at `task_complete`. Use it for thread-total billing reconciliation; do **not** sum across turns of a thread (it's already cumulative).

`cost_nano_usd` is computed downstream as `(input_tokens + cache_creation × 1.25 + cache_read × 0.1 + output_tokens) × pricing[provider, model, ts]`. When `provider_model` is `None` (Cursor `default` auto-router), `cost_nano_usd` is `None`. Otherwise cost inherits its quality from `tokens_are_estimated` — there is no separate `cost_is_estimated` flag.

Display rule for the dashboard:

```python
def format_token_label(usage: AgentUsageType) -> str:
    label = f"{usage.input_tokens + usage.output_tokens:,} tokens"
    if usage.tokens_are_estimated:
        label += " (estimated)"
    return label
```

Aggregates: `SUM(input_tokens + output_tokens)` directly. Filter or split by `tokens_are_estimated` if a downstream view needs to label or separate the two populations. "Codex thread total" is `thread_cumulative_tokens` from the latest record in the thread (`ORDER BY result.timestamp.end_utc_date DESC LIMIT 1`).

### 2.6 Encrypted reasoning is metadata-only

Codex stores reasoning (`response_item.reasoning`) as an opaque `encrypted_content` blob. We **do not decrypt.** A `MessageContent(type=THINKING, encrypted=true, byte_length=<N>, text=null)` block is captured in its place.

The fact that reasoning happened, how much, and at what `reasoning_effort` (which lives in `agent_metadata['reasoning_effort']` for Codex) is recoverable. The text is not. Mirror the agent's own choice.

### 2.7 `agent_metadata` is the loose round-trip bag

All agent-specific stamps and any field we don't promote to the typed spine live in `agent_metadata: dict`. Per `CALL_RECORD_MAPPING.md` §4 ("the schema we ship for MVP must round-trip every byte we care about"), the parser dumps unknown fields here, and downstream consumers either query directly via JSONB ops or ingest the bag as context to AI consumers that handle loose JSON natively.

Two principles:

1. **Per-agent shape is by convention, not enforcement.** Each agent's parser puts what it has under stable keys (see §1.5 for examples). Schema doesn't enforce; tests do.
2. **Promoting is a non-breaking refactor.** If a field in `agent_metadata` ever earns its way to the typed spine, the typed slot reads from the dict if absent on the row, and the dict is gradually cleared by re-parses. No client release needed.

The dict is **never** a place to put PII or secrets — those are caught by gateway-stage redaction (§3 of `DESIGN.md`) before bytes ever reach the parser.

### 2.8 Provider/model can be null

Cursor's `modelConfig.modelName == 'default'` means the auto-router picked a model per-turn and we cannot recover which one from local data. Set `query.provider_model = None` and document downstream:
- Cost is `None`.
- Provider-specific metrics (cache fields) are `None`.
- Dashboard renders "Cursor (auto-routed)" as the provider.

### 2.9 Status — three terminal states only

A record is created **only when its turn has a definitive outcome.** There is no transitional state in the schema; the in-flight phase is parser-internal.

```
SUCCESS     — turn closed cleanly. Source-side terminator observed:
              • Claude Code: a later promptId arrived in the same chat
              • Cursor:      a later type=1 user bubble arrived
              • Codex:       an event_msg/task_complete arrived

INCOMPLETE  — idle-flush. Open turn buffered for >30 minutes with no new bytes.
              Used for crashed agents, mid-turn abandonment, or sessions that
              ended without compaction.

FAILED      — the source agent recorded an error within the turn. Rare in
              capture data.
```

The parser accumulates raw stream data in its own buffer (gateway-side or backend-ingester-side, depending on architecture) and emits an `AgentCallRecord` only when one of the three terminal states is reached. **Every record a consumer sees is final** — no "this might change later" semantics.

Re-upload safety (gateway retry, backend re-parse) is independent of status — same `id` (§2.10) means same content, upsert is identity. Not a state-machine transition.

Aggregates that care about completed work filter `status=SUCCESS`. INCOMPLETE / FAILED are typically excluded from token/time aggregates but useful for monitoring (rate of INCOMPLETE = agent crashes or user abandonment).

### 2.10 `id` is deterministic

```
id = blake2b_128(agent_app.name || '\x1f' || chat.chat_id || '\x1f' || turn.turn_id)
```

Encoded as base32 for compact display. Same source bytes → same `id`. Re-uploads, gateway retries, and backend re-parses upsert by `id` and never duplicate.

### 2.11 Capture provenance is required

Every `AgentCallRecord` carries a non-null `capture` group:

```python
CaptureMetadata(
    source='claude-code' | 'cursor' | 'codex',
    source_path='~/.claude/projects/.../<sessionId>.jsonl',
    record_ref='<promptId>',
    schema_version='2.1.122',
    captured_at_utc=<gateway clock>,
    gateway_version='@proxai/gateway 0.1.4',
)
```

Non-negotiable — without it we can't re-parse historical records under an updated parser, can't triage schema-drift, and can't honor user data-deletion by source. Closes [G-S6].

### 2.12 `result.content` is the canonical chronological event log

The full content of one turn — every thinking block, every text block, every tool call, every tool result — is `result.content`, a `list[MessageContent]` in the same order they arrived in the source.

Parsers populate `content` directly. The `output_text` shortcut (concatenated assistant TEXT blocks) is a derived view; never write it directly. `tool_summary` is also derived. They are stored as columns for fast dashboard rollups without scanning the `content` blob.

---

## 3. Differences from `CallRecord` — what changed and why

| `CallRecord` field | `AgentCallRecord` treatment | Why |
|---|---|---|
| `query.prompt: str` | dropped | Agents always have at least one user message; use `query.user_input.content`. |
| `query.chat: Chat` | dropped | History is parent-pointer (§2.3, §5). |
| `query.parameters.{temperature, max_tokens, stop, n}` | dropped | Agents do not write call parameters to disk. |
| `query.parameters.thinking` | moved → `agent_metadata['reasoning_effort']` | Codex-specific; lives in the loose bag. |
| `query.tools: list[Tools]` (enum) | moved → `agent_metadata['tool_inventory']` | Replaced with a loose, agent-specific list. Closes [G-T1]. |
| `query.system_prompt` | moved → `agent_metadata['system_prompt']` | Codex-only, large, not on MVP analytic path. |
| `query.output_format` | dropped | Agents always produce text + tools. |
| `query.connection_options` | dropped | Cache / fallback / endpoint-override are SDK concerns. |
| `query.hash_value` | dropped | Replaced by `id` (§2.10). |
| `result.choices` | dropped | Agents are always n=1. |
| `result.output_image` / `output_audio` / `output_video` / `output_json` / `output_pydantic` | dropped | Agents output text + tools. Only `output_text` shortcut retained. |
| `result.error` / `result.error_traceback` | dropped (moved → `agent_metadata['incomplete_reason']` / etc.) | Disk capture has no Python tracebacks; error explanations are rare and synthetic. The loose bag handles them when present. |
| `connection: ConnectionMetadata` | dropped | Replaced by `capture: CaptureMetadata` (§2.11). |
| `debug.raw_provider_response` | dropped | We capture from disk, not network. |
| `result.usage` | extended → `AgentUsageType` | Adds Anthropic cache fields, estimation flags, thread cumulative (§2.5). Closes [G-U1]. |
| `MessageContent(TOOL).tool_content.ToolContent` | extended | Adds `arguments`, `result`, `result_truncated`, `exit_code`, `result_cwd`, `duration_ms`, `call_id` (§1.2). Closes [G-T2]. |
| `MessageContent(THINKING)` | extended | Adds `encrypted: bool`, `byte_length: int` for Codex (§2.6). |
| (none) | **+** `turn`, `chat`, `agent_app`, `capture` | New typed spine. Closes [G-S1]–[G-S6]. |
| (none) | **+** `agent_metadata: dict` | Loose bag for everything agent-specific (cwd, git, modes, sandbox, …). Closes [G-S7]–[G-S9], [G-A1], [G-M1] without forcing typed slots. |

Shape primitives — `MessageContent`, `ToolContent` (extended), `Citation`, `ProviderModelType` — are shared with `CallRecord`. A parser can populate either record type with the same content blocks.

---

## 4. Per-agent field mapping

Condensed view of the typed spine; full field-by-field details in `CALL_RECORD_MAPPING.md`. **Per-agent `agent_metadata` keys are documented in §1.5** rather than being repeated here.

| `AgentCallRecord` field | Claude Code | Cursor | Codex |
|---|---|---|---|
| `id` | derived | derived | derived |
| `turn.turn_id` | `promptId` | first user-bubble `bubbleId` | `task_started.turn_id` |
| `turn.parent_turn_id` | prior `promptId` | prior user-bubble `bubbleId` | prior `task_started.turn_id` |
| `turn.status` | derived | derived | direct (`task_started`/`task_complete` bracket) |
| `chat.chat_id` | `sessionId` | `composerId` | `threads.id` |
| `chat.chat_title` | `ai-title` | `composerData.name` | `threads.title` |
| `agent_app.name` | `CLAUDE_CODE` | `CURSOR` | `CODEX` |
| `agent_app.version` | `message.version` | `_v` | `threads.cli_version` |
| `query.user_input.content` | `user.message.content` | `bubble.text` + `richText` + images | `event_msg/user_message.message` ‖ `response_item/message[role=user]` |
| `query.user_input.attachments` | `attachment` records this turn | `bubble.context.{selections,commits,…}` | (rare) |
| `query.user_input.slash_command` | parse from `<command-name>` markup | null | (in user_message text) |
| `query.provider_model.provider` | infer from model prefix | infer / null when default | `threads.model_provider` ✓ |
| `query.provider_model.model` | `message.model` | `composerData.modelConfig.modelName` | `threads.model` ✓ |
| `result.content` | assistant content + tool_result user blocks | bubbles `type=2` text/thinking/toolFormerData | `response_item` (message/reasoning/function_call/function_call_output/web_search_call) + event_msg sidecars |
| `result.usage.input_tokens` (auth.) | sum across assistants ✓ | null | null |
| `result.usage.cache_*_tokens` | sum ✓ | null | null |
| `result.usage.estimated_*_tokens` | null (we have authoritative) | tiktoken | tiktoken |
| `result.usage.thread_cumulative_tokens` | null | null | `threads.tokens_used` snapshot ✓ |
| `result.timestamp.start_utc_date` | first record `timestamp` | first user-bubble `createdAt` | `task_started.started_at` |
| `result.timestamp.end_utc_date` | last record `timestamp` | last assistant-bubble `createdAt` | `task_complete.completed_at` |
| `result.timestamp.time_to_first_token_ms` | null | null | `task_complete.time_to_first_token_ms` ✓ |
| `capture.record_ref` | `promptId` | `composerId:user_bubbleId` | `turn_id` |
| `agent_metadata` | see §1.5 | see §1.5 | see §1.5 |

✓ = direct read; gaps are filled with derivation, estimation, or null.

---

## 5. Walking a chat

The data model is one table — `agent_call_records` — partitioned by `chat_id`. To reconstruct a chat's full history given any one of its records:

```python
def walk_chat(rec: AgentCallRecord, store: AgentRecordStore) -> list[AgentCallRecord]:
    # Walk back to the first turn (parent_turn_id is None).
    cur = rec
    while cur.turn.parent_turn_id is not None:
        prev = store.get(rec.agent_app.name, rec.chat.chat_id, cur.turn.parent_turn_id)
        if prev is None:
            break                                       # gap (unflushed bytes); stop walking
        cur = prev
    # Walk forward by parent_turn_id matches in this chat.
    chain = [cur]
    while True:
        nxt = store.find_child(rec.agent_app.name, rec.chat.chat_id,
                               parent_turn_id=chain[-1].turn.turn_id)
        if nxt is None:
            break
        chain.append(nxt)
    return chain
```

Index hint for the backend: `(agent_app, chat_id, parent_turn_id)` covers both the back-walk and the forward-walk. `(agent_app, chat_id, turn_id)` is the primary key.

To materialize chat history into a `Chat` object (for replay, support, debug — not used by MVP analytics):

```python
def materialize_chat(rec: AgentCallRecord, store: AgentRecordStore) -> Chat:
    chain = walk_chat(rec, store)[:-1]                  # everything before this turn
    messages: list[Message] = []
    for prior in chain:
        messages.append(Message(role='user', content=prior.query.user_input.content))
        assistant_blocks = [
            b for b in prior.result.content
            if b.type in (ContentType.TEXT, ContentType.TOOL)
        ]
        messages.append(Message(role='assistant', content=assistant_blocks))
    # System prompt (if needed for replay) lives in agent_metadata for Codex; absent for others.
    return Chat(
        system_prompt=rec.agent_metadata.get('system_prompt'),
        messages=messages,
    )
```

This is a backend or client-side helper run on demand. The raw `AgentCallRecord` does not store materialized history.

### 5.1 What we deliberately don't model

- **No `Session` / `Project` / `Workspace` row.** Those are concepts; the database is one table, partitioned by `chat_id`, with metadata stamps on each record. "Tokens by project" is a downstream rollup — project resolution is done independently, by reading `agent_metadata['cwd']` and applying whatever project-breadcrumb logic the dashboard wants. No JOINs in the record schema.
- **No cross-chat relationship.** Sub-agents are independent chats (§2.4). Auto-compaction in Claude Code creates a new `chat_id`; no link. `/resume` of an old chat re-opens the same `chat_id`; chain naturally extends.
- **No "conversation" entity above chat.** Anything that wants to thread chats together (e.g. "show me all sub-agent runs spawned from this chat") is post-MVP enrichment, not schema.

Keeping the schema turn-flat — one row per turn, the loose bag for everything else — makes analytic queries trivially simple and avoids a tangle of session/conversation/thread tables that drift from the source agents over time.

---

## 6. Examples

Imports for all examples:

```python
import datetime as dt
from proxai.types import (
    ProviderModelType, MessageContent, ContentType,
    ToolContent, ToolKind, Citation,
)
from proxai_gateway.types import (
    AgentCallRecord, TurnInfo, TurnStatusType,
    ChatStamp, AgentApp, AgentAppName,
    AgentQueryRecord, UserInput, AttachmentRef, AttachmentKind,
    AgentResultRecord, AgentUsageType, AgentTimeStampType,
    CaptureMetadata,
)
```

### 6.1 Claude Code — simple text turn

```python
AgentCallRecord(
    id="6JZQX2WQK7…",
    turn=TurnInfo(
        turn_id="a1060146-31f7-49bc-b4ad-b60a1f3dc509",
        parent_turn_id="0af333cd-bafe-4d48-9bf6-a2926d2cd0df",   # the /clear turn before
        status=TurnStatusType.SUCCESS,
    ),
    chat=ChatStamp(
        chat_id="9d2576ec-9d07-4ff3-83d8-4368186bb4e3",
        chat_title="Algorithm design for gateway",
        created_at_utc=dt.datetime(2026, 4, 29, 4, 40, 17),
    ),
    agent_app=AgentApp(name=AgentAppName.CLAUDE_CODE, version="2.1.122"),
    query=AgentQueryRecord(
        user_input=UserInput(
            content=[MessageContent(type=ContentType.TEXT, text="Ok we made the basic structure…")],
            attachments=[],
        ),
        provider_model=ProviderModelType(provider="anthropic", model="claude-opus-4-7"),
    ),
    result=AgentResultRecord(
        content=[
            MessageContent(type=ContentType.THINKING, text="The user wants…"),
            MessageContent(type=ContentType.TEXT, text="I'll explore the project structure and then…"),
        ],
        output_text="I'll explore the project structure and then…",
        usage=AgentUsageType(
            input_tokens=6, output_tokens=444,
            tokens_are_estimated=False,
            cache_creation_input_tokens=8004, cache_read_input_tokens=14865,
            cost_nano_usd=312_400_000,
        ),
        timestamp=AgentTimeStampType(
            start_utc_date=dt.datetime(2026, 4, 29, 13, 34, 23, 793000),
            end_utc_date=dt.datetime(2026, 4, 29, 13, 34, 29, 154000),
            response_time=dt.timedelta(seconds=5, milliseconds=361),
        ),
    ),
    capture=CaptureMetadata(
        source="claude-code",
        source_path="~/.claude/projects/-Users-osmanaka-repos-proxai-proxai-gateway/9d2576ec-…jsonl",
        record_ref="a1060146-31f7-49bc-b4ad-b60a1f3dc509",
        schema_version="2.1.122",
        captured_at_utc=dt.datetime(2026, 4, 29, 13, 39, 25),
        gateway_version="@proxai/gateway 0.1.0",
    ),
    agent_metadata={
        "cwd": "/Users/osmanaka/repos/proxai/proxai_gateway",
        "git_branch": "HEAD",
        "permission_mode": "acceptEdits",
        "entrypoint": "cli",
        "is_archived": False,
    },
)
```

### 6.2 Claude Code — turn with tool calls

Same shape as 6.1, but `result.content` interleaves text, tool_use, and tool_result blocks. The Task tool (sub-agent spawn) shows up as a regular `kind=CALL` block with `name='Task'` — nothing structurally special.

```python
result=AgentResultRecord(
    content=[
        MessageContent(type=ContentType.THINKING, text="Need to find where serializer is called…"),
        MessageContent(
            type=ContentType.TOOL,
            tool_content=ToolContent(
                kind=ToolKind.CALL, name="Read",
                call_id="toolu_01XJEJeJEZSyHgs5KcWGZUsR",
                arguments={"file_path": "/Users/osmanaka/repos/proxai/proxai/src/proxai/serializers/type_serializer.py"},
                arguments_truncated=False,
            ),
        ),
        MessageContent(
            type=ContentType.TOOL,
            tool_content=ToolContent(
                kind=ToolKind.RESULT, name="Read",
                call_id="toolu_01XJEJeJEZSyHgs5KcWGZUsR",
                result="<file contents>",                # 4 KB excerpt
                result_truncated=True,
                result_path="~/.claude/projects/.../tool-results/bcp1v8qug.txt",
                duration_ms=84,
            ),
        ),
        MessageContent(
            type=ContentType.TOOL,
            tool_content=ToolContent(
                kind=ToolKind.CALL, name="Bash",
                call_id="toolu_01HRiKqUbTCWPA6d72WQbwxz",
                arguments={"command": "rg --files src/", "description": "Inventory source files"},
            ),
        ),
        MessageContent(
            type=ContentType.TOOL,
            tool_content=ToolContent(
                kind=ToolKind.RESULT, name="Bash",
                call_id="toolu_01HRiKqUbTCWPA6d72WQbwxz",
                result="src/proxai/types.py\nsrc/proxai/client.py\n…",
                exit_code=0, duration_ms=63,
            ),
        ),
        MessageContent(type=ContentType.TEXT, text="Found the serializer at types.py:838. It handles…"),
    ],
    output_text="Found the serializer at types.py:838. It handles…",
    tool_summary={"Read": 1, "Bash": 1},
    usage=AgentUsageType(
        input_tokens=47, output_tokens=4982,
        tokens_are_estimated=False,
        cache_creation_input_tokens=11633, cache_read_input_tokens=162910,
    ),
    timestamp=...,
),
```

### 6.3 Cursor — turn with rich attachments, auto-routed model

User @-mentioned a file range. `provider_model` is null because `modelName == 'default'`.

```python
AgentCallRecord(
    id="9P3K…",
    turn=TurnInfo(turn_id="a81ac48a-…", parent_turn_id=None, status=TurnStatusType.SUCCESS),
    chat=ChatStamp(
        chat_id="831d2410-0ad6-48d8-99aa-ed03b507f8de",
        chat_title="TypeError traceback issue",
        created_at_utc=dt.datetime(2026, 2, 21, 21, 55, 18, 742000),
    ),
    agent_app=AgentApp(name=AgentAppName.CURSOR, version="13:3"),
    query=AgentQueryRecord(
        user_input=UserInput(
            content=[MessageContent(
                type=ContentType.TEXT,
                text="@.../model_connector.py:470-474 I got this error… TypeError: __traceback__ must be a traceback or None",
            )],
            attachments=[
                AttachmentRef(
                    kind=AttachmentKind.FILE_SELECTION,
                    name="model_connector.py (470-474)",
                    path="/Users/osmanaka/repos/proxai/proxai/src/proxai/connectors/model_connector.py",
                    range={"start_line": 470, "end_line": 474},
                    metadata={"language": "python"},
                ),
            ],
        ),
        provider_model=None,                                # 'default' → unknown
    ),
    result=AgentResultRecord(
        content=[...],                                      # 49 bubbles collapsed into blocks
        output_text="The error happens because traceback.format_exc() returns a string…",
        tool_summary={"read_file_v2": 8, "ripgrep_raw_search": 5, "semantic_search_full": 1,
                      "edit_file_v2": 1, "read_lints": 1, "web_search": 1},
        usage=AgentUsageType(
            input_tokens=1820, output_tokens=14400,
            tokens_are_estimated=True,
            cost_nano_usd=None,                              # provider unknown → no cost
        ),
        timestamp=AgentTimeStampType(
            start_utc_date=dt.datetime(2026, 2, 21, 21, 55, 18, 742000),
            end_utc_date=dt.datetime(2026, 2, 21, 21, 57, 0),
            response_time=dt.timedelta(seconds=101, milliseconds=258),
        ),
    ),
    capture=CaptureMetadata(
        source="cursor",
        source_path="~/Library/Application Support/Cursor/User/globalStorage/state.vscdb",
        record_ref="831d2410-…:a81ac48a-…",
        schema_version="13:3",
        captured_at_utc=dt.datetime(2026, 4, 29, 10, 17),
        gateway_version="@proxai/gateway 0.1.0",
    ),
    agent_metadata={
        "cwd": "/Users/osmanaka/repos/proxai/proxai",
        "agent_mode": "agent",
        "force_mode": "edit",
        "context_usage_percent": 15.537,
        "subtitle": "Edited model_connector.py",
        "agent_backend": "cursor-agent",
        "files_changed_count": 1,
        "user_input_rich_text": {"root": {"children": [...]}},   # lexical-format JSON, round-trip
    },
)
```

### 6.4 Codex — turn with bash exec and encrypted reasoning

```python
AgentCallRecord(
    id="2KX…",
    turn=TurnInfo(
        turn_id="019dd9ac-d822-7992-a311-db298dd37939",
        parent_turn_id="019dd9ac-9a9f-76d0-a50a-db8f73e9c7c5",
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
            MessageContent(
                type=ContentType.TOOL,
                tool_content=ToolContent(
                    kind=ToolKind.CALL, name="exec_command",
                    call_id="call_fztvKvJsPRt027TqYdT75DPT",
                    arguments={"command": ["/bin/zsh", "-lc", "git status --short"]},
                ),
            ),
            MessageContent(
                type=ContentType.TOOL,
                tool_content=ToolContent(
                    kind=ToolKind.RESULT, name="exec_command",
                    call_id="call_fztvKvJsPRt027TqYdT75DPT",
                    result="?? .agents/\n?? AGENTS.md\n",
                    exit_code=0, result_cwd="/Users/osmanaka/repos/proxai/proxai",
                    duration_ms=413,
                ),
            ),
            MessageContent(type=ContentType.THINKING, encrypted=True, byte_length=894),
            MessageContent(type=ContentType.TEXT, text="Looked at provider docs…"),
        ],
        output_text="Looked at provider docs…",
        tool_summary={"exec_command": 1},
        usage=AgentUsageType(
            input_tokens=4200, output_tokens=520,
            tokens_are_estimated=True,
            thread_cumulative_tokens=363741,
            cost_nano_usd=8_400_000_000,
        ),
        timestamp=AgentTimeStampType(
            start_utc_date=dt.datetime(2026, 4, 29, 14, 37, 38),
            end_utc_date=dt.datetime(2026, 4, 29, 14, 37, 56),
            response_time=dt.timedelta(seconds=18),
            time_to_first_token_ms=2078,                          # Codex direct
        ),
    ),
    capture=CaptureMetadata(
        source="codex",
        source_path="~/.codex/sessions/2026/04/29/rollout-2026-04-29T10-37-25-019dd9ac-…jsonl",
        record_ref="019dd9ac-d822-7992-a311-db298dd37939",
        schema_version="0.126.0-alpha.8",
        captured_at_utc=dt.datetime(2026, 4, 29, 14, 41),
        gateway_version="@proxai/gateway 0.1.0",
    ),
    agent_metadata={
        "cwd": "/Users/osmanaka/repos/proxai/proxai",
        "git_sha": "88cdf9014ec036dc714860ae7b43b01140ed7187",
        "git_branch": "main",
        "git_origin_url": "git@github.com:proxai/proxai.git",
        "sandbox_policy": {"type": "workspace-write", "network_access": False},
        "approval_mode": "on-request",
        "reasoning_effort": "medium",
        "originator": "Codex Desktop",
        "source": "vscode",
        "system_prompt": "You are Codex, a coding agent based on GPT-5...",
        "encrypted_thinking_byte_length": 1918,
    },
)
```

### 6.5 Idle-flushed (`INCOMPLETE`) turn

The turn opened, then no new bytes for 30 minutes — the parser gave up waiting and emitted what it had. `usage` is best-effort over the partial content. The explanation goes in `agent_metadata['incomplete_reason']`; the typed schema doesn't carry an error field (see §2.9).

```python
AgentCallRecord(
    turn=TurnInfo(turn_id="…", parent_turn_id="…", status=TurnStatusType.INCOMPLETE),
    chat=…,
    query=AgentQueryRecord(user_input=…, provider_model=…),
    result=AgentResultRecord(
        content=[...whatever made it to disk before the gap...],
        output_text=None,                                    # no terminator → no final text
        usage=AgentUsageType(
            input_tokens=<over partial content>,
            output_tokens=<over partial content>,
            tokens_are_estimated=True,
        ),
        timestamp=AgentTimeStampType(
            start_utc_date=<turn start>,
            end_utc_date=<last bytes observed>,
            response_time=<delta>,
        ),
    ),
    capture=…,
    agent_metadata={
        "incomplete_reason": "Idle-flush after 30 min — turn never closed.",
        # ... other agent-specific stamps
    },
)
```

---

## 7. Schema versioning and extensibility

- The doc you're reading is `AgentCallRecord` v0.1.
- The `schema_version` field on `capture` tracks the **upstream agent's** schema (`message.version`, `_v`, `cli_version`), not ours. Our schema's version is implied by the `gateway_version` field.
- **Adding new typed fields** is a non-breaking change: parsers populate the new field; old records read `null`/default.
  - New `agent_metadata` keys: any time, no migration. **This is the primary growth surface.**
  - New top-level groups: nullable; old records get `null`.
  - New `MessageContent` content types: extend `ContentType`; old parsers pass through.
- **Renaming or removing fields** is breaking and requires a migration. Use `agent_metadata` as a staging area.
- **Re-parsing historical bytes** is the routine update path: bump the parser, re-run over object-stored raw blobs (per `DESIGN.md` §2.1), upsert by `id`. Old fields go null where the new parser doesn't populate them.

---

## 8. Open questions

1. **`output_text` for tool-heavy turns.** When the assistant's only output is tool calls with no final text, `output_text` is `None`. Dashboard should handle gracefully — recommend "Used N tools: <tool_summary>" as the row label rather than "(empty response)."
2. **Encrypted reasoning across providers.** Only Codex encrypts today. If others adopt similar encryption, the existing `MessageContent(THINKING).encrypted` flag handles it uniformly. No schema change needed.
3. **Multi-modal output for agents.** None of the three observed agents produce images/audio/video as output. Schema inherits from `CallRecord` if it ever appears.
4. **Idle-flush threshold.** 30 min same as in `ALGORITHM_*.md`. Calibrate after beta data.

---

## 9. Next steps

1. Write the TypeScript types in `proxai_nest/src/types/agent_call_record.ts` matching this design. Generate a JSON Schema from the TS types for client-side validation.
2. Update `CALL_RECORD_MAPPING.md`: every gap (`G-S1`–`G-S9`, `G-T1`, `G-T2`, `G-U1`, `G-A1`, `G-M1`, `G-D1`, `G-D2`) is now closed by either a typed slot or `agent_metadata` in `AgentCallRecord`. Cross-link.
3. Implement the parsers — each agent's parser produces `AgentCallRecord` directly:
   - `packages/nest-ingest/src/parsers/claude_code.ts` (per `ALGORITHM_CLAUDE.md` §4)
   - `packages/nest-ingest/src/parsers/cursor.ts` (per `ALGORITHM_CURSOR.md` §4)
   - `packages/nest-ingest/src/parsers/codex.ts` (per `ALGORITHM_CODEX.md` §4)
4. Build a fixture corpus (raw bytes + expected `AgentCallRecord` JSON) and run as golden-file tests. Each fixture asserts both the typed spine and the per-agent `agent_metadata` keys documented in §1.5.
5. Define the database schema. One table — `agent_call_records`. Primary key `(agent_app, chat_id, turn_id)`. Indexes: `(agent_app, chat_id, parent_turn_id)` for chain walks; `(agent_app, capture.captured_at_utc)` for ingest monitoring. JSONB columns for `result.content`, `query.user_input.attachments`, `agent_metadata`. Optional functional indexes on `agent_metadata` keys (e.g. `agent_metadata->>'cwd'`) added when downstream queries warrant.
6. Build the project-breadcrumb derivation as a separate concern (read `agent_metadata['cwd']`, apply git-root / monorepo logic, produce a `chat → project` mapping table). Keep this independent of the record schema.
7. Write the analytics queries that answer the user's three MVP questions as templated SQL — confirm none of them need the chain walk.
