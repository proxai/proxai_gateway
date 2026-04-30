# AgentCallRecord Mapping — Claude Code, Cursor, Codex

> **Backend-side reference.** Parsing happens in `proxai_nest`, not in the gateway. The gateway uploads redacted raw bytes (see `01_INTRO.md` §2 and the DTO contract in `03_FLUSHING_ALGORITHM.md` §3); this doc is the reference for converting those bytes into `AgentCallRecord` shape on the backend. It will eventually move to the `proxai_nest` repo.

How the data each agent writes to disk maps onto the `AgentCallRecord` schema defined in `04_AGENT_CALL_RECORD.md`. The base SDK `CallRecord` (`proxai/src/proxai/types.py`) is the conceptual ancestor; `04_AGENT_CALL_RECORD.md` §3 documents the deliberate divergences.

Some fields are inherently N/A for third-party-agent capture (proxai cache layer, fallback chains, debug sidecar). The goal of this doc is to be honest about what we get for free, what has to be derived, and what cannot be recovered at all.

## Legend

- **✓** direct — the field is present verbatim in the agent's on-disk data
- **◐** partial — derivable, lossy, or only sometimes available
- **✗** not captured — would require a different capture mechanism (proxy / MITM)
- **—** not applicable for third-party agent capture

---

## 1. Capability matrix

### `query` — request side

| `query.*` field | Claude Code | Cursor | Codex | Notes |
|---|:-:|:-:|:-:|---|
| `prompt` (single-shot) | ✓ | ✓ | ✓ | First user message of session if no chat history |
| `chat.system_prompt` | ◐ | ✗ | ✓ | Claude Code: `system` entries (`isMeta`); Codex: `session_meta.base_instructions`; Cursor: not exposed |
| `chat.messages[]` | ✓ | ✓ | ✓ | Reconstructable in turn order |
| `provider_model.provider` | ◐ | ◐ | ✓ | Claude Code/Cursor: infer from model name prefix; Codex: `session_meta.model_provider` |
| `provider_model.model` | ✓ | ✓ | ✓ | `message.model` / `bubble.modelInfo.modelName` / `threads.model` |
| `provider_model.provider_model_identifier` | ◐ | ◐ | ◐ | All three give a marketing name, not the dated identifier |
| `parameters.temperature` | ✗ | ✗ | ✗ | Agent-internal, never written to disk |
| `parameters.max_tokens` | ✗ | ✗ | ✗ | Same |
| `parameters.stop` | ✗ | ✗ | ✗ | Same |
| `parameters.n` | — | — | — | None of these support `n>1` |
| `parameters.thinking` | ◐ | ◐ | ◐ | Claude Code: presence of `thinking` blocks → derive a level heuristically; Cursor: `allThinkingBlocks` count; Codex: `threads.reasoning_effort` (`low`/`medium`/`high` direct ✓) |
| `tools[]` (Tools enum) | ◐ | ◐ | ◐ | The enum only covers `WEB_SEARCH`. Real coding-agent tools (Read, Edit, Bash, MCP, …) need a richer representation — see §3 gap [G-T1]. |
| `output_format.type` | ✓ | ✓ | ✓ | Always `TEXT` for these agents |
| `output_format.pydantic_*` / `json` | — | — | — | Not used by these agents |
| `connection_options.*` | — | — | — | Cache / fallback are proxai-SDK concerns |
| `hash_value` | ✓ | ✓ | ✓ | Computed by us at parse time |

### `result` — response side

| `result.*` field | Claude Code | Cursor | Codex | Notes |
|---|:-:|:-:|:-:|---|
| `status` | ✓ | ✓ | ✓ | Derive: `SUCCESS` if assistant turn closed normally |
| `role` | ✓ | ✓ | ✓ | Always `ASSISTANT` for results |
| `content[]` (`MessageContent`) — TEXT | ✓ | ✓ | ✓ | Plaintext present in all three |
| `content[]` — THINKING | ✓ | ✓ | ✓ | Claude Code: `thinking` block; Cursor: `allThinkingBlocks`; Codex: `response_item.reasoning` |
| `content[]` — TOOL (call) | ✓ | ✓ | ✓ | Name + arguments captured; **but ToolContent has no `arguments` field today — gap [G-T2]** |
| `content[]` — TOOL (result) | ✓ | ✓ | ✓ | Inline result captured; **but ToolContent has no `result` field today — gap [G-T2]** |
| `content[]` — IMAGE / AUDIO / VIDEO / DOCUMENT | ◐ | ◐ | ✗ | Claude Code/Cursor: pasted attachments visible as `attachment` entries / `images` blocks; Codex: text-only |
| `content[]` — JSON / PYDANTIC_INSTANCE | — | — | — | Not used |
| `choices[]` | — | — | — | `n=1` always |
| `output_text` etc. (derived) | ✓ | ✓ | ✓ | Adapter computes from `content` |
| `error` | ◐ | ✗ | ◐ | Claude Code: rare error entries; Codex: `event_msg` may carry; Cursor: not exposed in bubbles |
| `error_traceback` | ✗ | ✗ | ✗ | None of them write tracebacks to disk |
| `usage.input_tokens` | ✓ | ✓ | ◐ | Claude Code: per-turn; Cursor: per-bubble; Codex: only thread-total in `state_5.threads.tokens_used`, no per-turn split |
| `usage.output_tokens` | ✓ | ✓ | ◐ | Same as above |
| `usage.total_tokens` | ✓ | ✓ | ✓ | Claude Code/Cursor: derive; Codex: direct as thread total |
| `usage.estimated_cost` | ✗ | ✗ | ✗ | None of them write cost. We compute downstream from tokens × known model pricing. |
| `timestamp.start_utc_date` | ✓ | ✓ | ✓ | User-turn `timestamp` / `bubble.createdAt` / rollout line `timestamp` |
| `timestamp.end_utc_date` | ✓ | ✓ | ✓ | Assistant-turn `timestamp` / next `bubble.createdAt` / next-line `timestamp` |
| `timestamp.local_time_offset_minute` | ✗ | ✗ | ✗ | All write UTC; offset would have to come from the gateway clock |
| `timestamp.response_time` | ✓ | ◐ | ✓ | Derive `end-start`; Cursor's bubble boundaries are looser |
| `timestamp.cache_response_time` | — | — | — | proxai cache concept |

### `connection` — connection metadata

| `connection.*` field | Claude Code | Cursor | Codex | Notes |
|---|:-:|:-:|:-:|---|
| `result_source` | ✓ | ✓ | ✓ | Always `PROVIDER` (third-party agents already hit the provider) |
| `cache_look_fail_reason` | — | — | — | proxai cache concept |
| `endpoint_used` | ◐ | ✗ | ◐ | Inferable from provider, not directly recorded |
| `failed_fallback_models[]` | — | — | — | proxai-SDK concept |
| `feature_mapping_strategy` | — | — | — | proxai-SDK concept |

### `debug`

| `debug.*` field | Claude Code | Cursor | Codex |
|---|:-:|:-:|:-:|
| `raw_provider_response` | — | — | — |

---

## 2. Agent-specific notes

### Claude Code
- **Best per-turn detail of the three.** Anthropic-style usage is rich: `usage` includes `cache_creation_input_tokens`, `cache_read_input_tokens`, `cache_creation.ephemeral_{1h,5m}_input_tokens`, `service_tier`, `iterations[]` (for retries), `server_tool_use.{web_search_requests, web_fetch_requests}`. None of this fits in `UsageType` today — see gap [G-U1].
- Each entry carries `cwd`, `gitBranch`, `version` (Claude Code build), `sessionId`, `uuid`, `parentUuid` (forms a tree of branched conversations), `requestId`, `permissionMode`. **No `git_sha`** — only branch name.
- `system` entries with `isMeta=True` are session boundaries (init / compaction summary), not user-facing system prompts. Treat as session lifecycle markers, not LLM input.

### Cursor
- **Lowest-fidelity for telemetry purposes.** `tokenCount` is just `{inputTokens, outputTokens}` — no cache breakdown, no service tier. Bubble timestamps are looser (created on flush, not on send).
- **No git context at all** in bubbles. Workspace identity has to be derived from the workspace hash in the path or the `composerData.context.fileSelections` paths.
- `composerData.unifiedMode` (`agent` / `ask` / `edit`) and `forceMode` are the agent-mode signal — see gap [G-M1].
- `bubble.context` carries rich attachment metadata (folder selections, file selections, terminal files, selected commits/PRs, images). High-value to ProxAI customers ("what did the agent see?") but doesn't fit cleanly in `MessageContent`.

### Codex
- **Best git/workspace context of the three:** `session_meta.git` has `commit_hash`, `branch`, `repository_url` — full provenance.
- **Per-turn token counts are missing** — `state_5.threads.tokens_used` is a session total, not per-message. To get per-turn we'd have to attribute the delta to the most recent assistant message, which is approximate.
- `session_meta.dynamic_tools` is a complete inventory of tools the agent had access to at session start (`name`, `namespace`, `description`, `inputSchema`, `deferLoading`) — way richer than CallRecord's `Tools` enum.
- `threads.reasoning_effort` maps cleanly to `ThinkingType` (`low`/`medium`/`high`).
- `threads.sandbox_policy` and `approval_mode` describe the agent's operating envelope — useful for "what was the agent allowed to do?" but no home in `CallRecord` today.

---

## 3. Gaps in `CallRecord` for agent telemetry

What's missing if `CallRecord` is to faithfully represent third-party-agent capture. Each gap has a stable ID so it can be referenced from issues / PRs in the proxai repo.

### P0 — required for MVP

The capture is not useful without these. Either we add them to `CallRecord` proper, or we put them in a new sidecar type the Gateway emits alongside `CallRecord` (preferred — keeps `CallRecord` clean for the SDK use-case).

| ID | Field / change | Why |
|---|---|---|
| **G-S1** | `client_app: str` (`claude-code` \| `cursor` \| `codex` \| …) | Without this, records are unattributable. |
| **G-S2** | `client_app_version: str` | Schema-drift triage; comparing agent versions. |
| **G-S3** | `client_session_id: str`, `client_turn_id: str` | Drill-down + dedup. UUIDs are already in the source files; just a passthrough. |
| **G-S4** | `cwd: str \| None` | Per-turn working directory. |
| **G-S5** | `git: { sha?: str, branch?: str, origin_url?: str }` | Repo provenance. Codex provides all three; Claude Code provides `branch`; Cursor provides none — fields nullable. |
| **G-S6** | `capture: { source, path, record_ref, schema_version, captured_at }` | Provenance for the record itself. Idempotency derives from `(source, path, record_ref)`. `schema_version` is the upstream agent's `_v` field where present. |
| **G-T2** | `ToolContent.arguments: dict \| str \| None` and `ToolContent.result: str \| dict \| None` (+ `result_truncated: bool`) | Today `ToolContent` carries `name`, `kind`, `citations` only. For coding agents, the arguments and result are the whole point — we cannot lose them. |

### P1 — nice for MVP, not blocking

| ID | Field / change | Why |
|---|---|---|
| **G-M1** | `agent_mode: str \| None` (e.g. `agent` / `ask` / `edit` / `plan` / `default`) | Lets the dashboard split "is this a chat or an agentic run?" |
| **G-U1** | Extend `UsageType` with optional Anthropic-style cache fields: `cache_creation_input_tokens`, `cache_read_input_tokens`, `service_tier`, `request_iterations` | Real cost analysis on Claude Code traffic is impossible without these. Optional / nullable so non-Anthropic providers stay clean. |
| **G-T1** | Replace the `Tools` enum with a freeform `tool_inventory: list[ToolDescriptor]` on `QueryRecord`, where `ToolDescriptor = {name, namespace?, description?, schema?}` | The 1-value enum can't represent what coding agents actually use. Keep `WEB_SEARCH` as a known constant for back-compat. |
| **G-A1** | `attachments_summary: list[AttachmentRef]` (count, names, sizes — NOT content) | Cursor's bubble context is a goldmine but the full content is too large; a metadata-only summary is the right tradeoff. |

### P2 — post-MVP

| ID | Field / change | Why |
|---|---|---|
| **G-S7** | `originator: str \| None` (e.g. `Codex Desktop`, `VSCode`, `terminal`) | Useful split for analytics; only Codex provides it today. |
| **G-S8** | `parent_turn_id: str \| None` for sub-agent / Task-style spawns | Codex's `thread_spawn_edges`. Claude Code's `parentUuid` already encodes branched-conversation trees. |
| **G-S9** | `permission_envelope: { sandbox_policy?, approval_mode?, permission_mode? }` | "What was the agent allowed to do at the time of this call?" |
| **G-D1** | Surface `stop_reason` / `stop_sequence` on the result | Diagnostic value; cheap. |
| **G-D2** | Per-turn `latency_breakdown: { ttft_ms?, total_ms? }` | None of these agents record TTFT, but if we ever proxy traffic we'll get it. |

### P3 — defer indefinitely

- `inference_geo`, `service_tier`, `speed` (Claude Code) — too provider-specific.
- Tool input JSON-schema preservation in TOOL blocks — useful for replay, expensive.
- `diagnostics` field from Claude Code — rare, low-value.

---

## 4. MVP scope

For MVP, we only need:

- All **P0** items (the seven `G-S*`/`G-T2` entries above).
- Everything else listed in §1 as ✓ or ◐.

Deliberately out of MVP, even though they're tempting:

- `G-U1` — Anthropic cache-token detail. We persist the raw `usage` blob in a `provider_usage_raw: dict` passthrough so we don't lose the data; we just don't promote individual fields into `UsageType` yet.
- `G-A1` — Cursor attachment summaries. Capture as raw blob in MVP; structure later.
- All P2/P3.

Pragmatic principle: **the schema we ship for MVP must round-trip every byte we care about, even if the named fields don't exist yet.** Concretely, the backend parser populates a `provider_specific: dict` passthrough alongside `CallRecord` from any unrecognized fields in the raw upload. Promoting fields out of `provider_specific` into typed columns is a backwards-compatible refactor; losing the data because we didn't capture it is not. Since the gateway always ships the redacted raw bytes (not just an extracted projection), re-parsing historical records under an updated schema is always possible.
