# Capture Targets — MVP

The exact files the gateway reads for each agent. One page, no alternatives.

Three agents, two file types: append-only JSONL, and SQLite KV stores. Polled every 5 minutes.

---

## Claude Code

### Read

```
~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl
```

- `<encoded-cwd>` = absolute path with `/` replaced by `-` (e.g. `-Users-osmanaka-repos-proxai-proxai-gateway`)
- One JSONL file per session. Append-only.
- Track per-file byte offset; on poll, read from offset to EOF, parse new lines, advance offset.

### What's inside

One JSON object per line, with a top-level `type`:
- `user` — user prompts (`message.content` plaintext)
- `assistant` — assistant turns (text + tool uses)
- `system` — system messages
- `attachment` — pasted files / images
- `tool_use`, `tool_result` — tool calls and their results
- `file-history-snapshot`, `permission-mode`, `ai-title`, `last-prompt`, `queue-operation` — session metadata

### Skip

Everything else under `~/.claude/`. Specifically never read:
- `~/.claude/settings.json` (user secrets / API keys)
- `~/.claude/sessions/`, `~/.claude/cache/`, `~/.claude/statsig/`, `~/.claude/telemetry/` (internal state)
- `~/.claude/history.jsonl` (cross-project shell-history-style; out of scope for v1)
- `~/.claude/plugins/`, `~/.claude/skills/`, `~/.claude/memories/`, `~/.claude/todos/` (user content; defer to a later phase with explicit consent)

---

## Cursor

### Read

```
~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
~/Library/Application Support/Cursor/User/workspaceStorage/<workspace-hash>/state.vscdb
```

- SQLite databases. **Open read-only with `?mode=ro`** and **snapshot via `VACUUM INTO` to a temp file** before parsing — Cursor writes under WAL and a naive read can race.
- Track last-seen `rowid` per (file, table) on each poll.

### What's inside

Two tables, one of interest:

- **`cursorDiskKV`** — read this. Two key prefixes:
  - `composerData:<composerId>` — conversation metadata (title, mode, token usage, bubble list). JSON value, schema-versioned (`_v:13` currently).
  - `bubbleId:<composerId>:<bubbleId>` — individual messages. JSON value, schema-versioned (`_v:3` currently). `text`/`richText` carry the prompt or response in plaintext; `toolFormerData` carries full tool call traces.
- **`ItemTable`** — **skip entirely.** Holds workbench/UI state and the auth tokens (`cursorAuth/accessToken`, `cursorAuth/refreshToken`).

### Skip

- `ItemTable` (entire table — no whitelisting, no exceptions)
- All non-`*.vscdb` files under `~/Library/Application Support/Cursor/`
- `state.vscdb-shm`, `state.vscdb-wal`, `state.vscdb.backup` (we read the snapshot we created, not these)

---

## Codex

### Read

```
~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ISO-timestamp>-<session-uuid>.jsonl
~/.codex/state_5.sqlite        (sidecar metadata; read-only)
```

JSONL is the source of truth; the SQLite sidecar joins extra metadata onto it.

### What's inside

**JSONL rollouts** — one JSON object per line, shape `{timestamp, type, payload}`. Types we care about:
- `session_meta` — once per file: `cwd`, `cli_version`, `model_provider`, `git`, `base_instructions`
- `response_item` — the actual model interactions. `payload.type` is one of:
  - `message` with `role` of `user` / `assistant` / `developer` — content in `payload.content[].text` (plaintext)
  - `function_call` — tool name + args
  - `function_call_output` — tool result (full content inline)
  - `reasoning` — model reasoning steps
- `turn_context` — per-turn snapshot
- `event_msg` — UI/control events (lower-value, but cheap to capture)

Track per-file byte offset.

**`state_5.sqlite`**, table **`threads`** only — read-only. Provides `id`, `rollout_path` (joins back to the JSONL), `title`, `first_user_message`, `model`, `tokens_used`, `cwd`, `git_sha`, `git_branch`, `git_origin_url`. Useful for thread-level enrichment without parsing the full rollout.

### Skip

- `~/.codex/auth.json` (OpenAI tokens — never read)
- `~/.codex/installation_id`
- `~/.codex/logs_2.sqlite` (application logs, not LLM payloads)
- `~/.codex/cache/`, `~/.codex/models_cache.json`, `~/.codex/.codex-global-state.json*`
- `~/.codex/memories/`, `~/.codex/skills/`, `~/.codex/plugins/`, `~/.codex/vendor_imports/` (user/extension content; out of v1 scope)
- All other tables in `state_5.sqlite` (`agent_jobs`, `stage1_outputs`, `thread_dynamic_tools`, `thread_goals`, `jobs`, `backfill_state`, `agent_job_items`, `thread_spawn_edges`, `device_key_bindings`, `remote_control_enrollments`, `_sqlx_migrations`)

---

## Cross-cutting rules

- **Append-only assumption.** Every JSONL we track is append-only. If a file shrinks, treat as truncation/rotation: reset cursor to 0, re-parse. Surface a warning so we notice if an agent ever rewrites in place.
- **WAL-aware reads** for every SQLite source. Always `?mode=ro` + `VACUUM INTO` snapshot. Never write to a consumer DB.
- **Schema versions** carry through. Capture the upstream `_v` field where present and store it on the buffered record so a future parser can re-process old captures.
- **The skip lists are part of the implementation, not documentation.** They are enforced by a unit test that walks the directories above and fails if any file matches a skip pattern but is opened by a collector.
