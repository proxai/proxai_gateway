# antigravity (gemini) File Format

The `gemini` source captures **Antigravity** Cascade conversation
databases. Antigravity ships in two surfaces — a CLI and an IDE — that
write the identical on-disk format under two sibling directories.
Both flow through one `gemini` source, discriminated by
`source_platform`.

## Scope decision

| Surface | Path | In scope? |
| --- | --- | --- |
| Antigravity CLI | `~/.gemini/antigravity-cli/conversations/<cascadeId>.db` | **Yes** → `source_platform = antigravity-cli` |
| Antigravity IDE | `~/.gemini/antigravity-ide/conversations/<cascadeId>.db` | **Yes** → `source_platform = antigravity-ide` |
| Gemini Desktop (`com.google.GeminiMacOS`) | `~/Library/Application Support/com.google.GeminiMacOS` | **No** — only settings/auth/onboarding Core-Data stores (`ZMINICHATSETTINGS`, `ZPERSISTENTSETTINGS`, `ZONBOARDINGSERVICESTOREDMODEL`, `ZUSERSTATUSSTOREDMODEL`). **No local conversation data on disk at all.** |
| Gemini CLI (the old Google `gemini` CLI) | — | **No** — deprecated; the gateway collects the Antigravity successor only. |

CLI and IDE share the **same** Cascade trajectory format and differ only
by their parent directory, so the gateway uses **one** discover/collect
parser and tags each discovered file with the `source_platform` of the
root it came from (per the "if only metadata changes, one parser" rule).

## Where the data lives (`~/.gemini/`)

All paths are home-relative and resolved cross-platform via `homedir()`
(same shape on macOS / Linux / Windows):

- `~/.gemini/antigravity-cli/conversations/<cascadeId>.db` — SQLite (current encoding)
- `~/.gemini/antigravity-ide/conversations/<cascadeId>.db` — SQLite (current encoding)
- `<cascadeId>.pb` siblings — a **legacy** standalone-protobuf encoding (pre-SQLite); **out of scope** (the glob matches `*.db` only).
- `history.jsonl`, `cache/last_conversations.json`, `~/.gemini/config/projects/<id>.json` — prompt index / workspace map / project registry; **out of scope** (the `.db` already carries prompts with richer context).

The filename stem (`<cascadeId>`) is the conversation's cascade id and is
the chat identity downstream (`chat_id = cascade_id`).

## Conversation `.db` (SQLite) — Windsurf/Cascade "trajectory" schema

A conversation DB is a Cascade trajectory. Tables present include
`trajectory_meta`, `steps`, `gen_metadata`, `executor_metadata`,
`parent_references`, `trajectory_metadata_blob`, `battle_mode_infos`.
The gateway allow-lists **three** of them (`GEMINI_ALLOWED_TABLES`):

### `trajectory_meta` — conversation identity (one row)

```
trajectory_meta(trajectory_id TEXT, cascade_id TEXT, trajectory_type INT, source INT)
```

- `cascade_id` == the `.db` filename (verified on 100% of samples).
- `source` is an integer discriminator (observed `17`); `trajectory_type` observed `4`.

### `steps` — the transcript

```
steps(idx INT PK, step_type INT, status INT, has_subtrajectory,
      metadata BLOB, error_details BLOB, permissions BLOB,
      task_details BLOB, render_info BLOB, step_payload BLOB, step_format INT)
```

- `rowid == idx` (INTEGER PK). `idx` is the rowid watermark unit.
- `step_payload` is a **protobuf blob** with recoverable plaintext. There is
  no shipped `.proto`; the wire format is decoded by a field-number scan
  (see `PROTOBUF-FIELDMAP.md`). User/assistant text is plain
  length-delimited UTF-8 inside the message; the payload also embeds
  workspace `file:///…` URIs, git remote, tool-permission strings, and
  session/turn UUIDs.

### `trajectory_metadata_blob` — workspace/git (one row, `id='main'`)

`trajectory_metadata_blob(id TEXT, data BLOB)` — `data` is a protobuf
embedding the workspace URI + git remote/branch + project ids.

The gateway queries `rowid AS rid, data` and flattens it into the row object:
- `idx` is set to the SQLite `rid`.
- `workspace_path` is parsed from the protobuf at path `1.1`, `1.2`, or `7`.
- `git_remote` is parsed from the protobuf at path `1.3.2`.

## `step_type` semantics

`step_type` is a **coarse render/category bucket; it does NOT name the
tool.** The authoritative tool identity is always the embedded string in
the step payload (`5.4.2`, or `20.7.2` on type 15) — never inferred from
`step_type` (types 5, 17, and 132 each multiplex several tools). Verified
buckets:

| step_type | role | meaning |
| --- | --- | --- |
| **14** | user | User message / prompt (text at payload `19.2`) |
| **15** | assistant | Agent-step envelope: reasoning text (`20.3`) and/or a wrapped tool call (`20.7`) |
| **23** | assistant | Assistant turn container / final message (text at `30.4`) |
| **17** | tool | Lite / preview tool-reference record (multiplexes view_file / write_to_file / run_command / …) |
| **5** | tool | File-mutation tool container (replace_file_content / write_to_file / multi_replace_file_content) |
| **7** | tool | grep_search |
| **8** | tool | view_file |
| **9** | tool | list_dir |
| **21** | tool | run_command |
| **25** | tool | find_by_name (typed result at `34`) |
| **31** | tool | read_url_content (fetched body at `40.2.6.3.2`) |
| **33** | tool | search_web |
| **127** | tool | invoke_subagent (blocking; work lives in separate trajectories) |
| **132** | tool | Management container (manage_task / schedule / list_permissions / …; manage_task result at `140`) |
| **138** | tool | ask_question (blocking) |
| **90** | system | Injected `<EPHEMERAL_MESSAGE>` / system-reminder (text at `103.1`) |
| **98** | system | Injected conversation-history markdown (text at `111.1`; can be empty) |
| **101** | system | System `[Message]` event with inline ISO timestamp (text at `114.1`) |

Tool steps carry a JSON args envelope `<8charToolCallId><tool_name>{…args,
"toolAction","toolSummary"}` inside the payload's `5.4` ToolCall message.

### Common envelope and timestamps

Every step shares the `step_payload.5` (`StepMeta`) envelope:
`5.3` is the role discriminator (`4`=user, `2`=model/tool-exec,
`5`=system/agent-text/lite); `5.1` is a `{1:epoch_seconds, 2:nanos}`
google.protobuf.Timestamp (**not** an ISO string — ISO is derived from the
binary); `5.20.4` carries the `cascade_id`, `5.20.1` the `trajectory_id`,
`5.20.2` the `idx`.
In addition:
- `5.12` carries the `turn_id` / `turn_group` UUID.
- `5.9.11` carries the `request_id`.
- `5.9.8.2` (field `2` inside the map/message at `5.9.8`) carries the `session_id`.
Inline ISO strings exist only inside step-101 (`114.1`) and step-98 (`111.1`) text.

## Reliability notes

- **Authoritative / verified at scale:** `cascade_id` (`5.20.4` == filename), `trajectory_id`, `idx`; the role discriminator `5.3`; tool name at `5.4.2`; user text `19.2`; assistant thinking `20.3`; system-event text `114.1`; ephemeral `103.1`; history `111.1` (may be empty); url body `40.2.6.3.2`.
- **Best-effort / interpretation caveats:** model id (`5.9.1`/`5.11` is a config id, not a display name) and token usage (`5.9.*` per-request counters, exact prompt/completion labels UNVERIFIED). The model **display name** and ground-truth token totals are absent from `step_payload` and require a `gen_metadata` join (not captured in v1). `30.4` is a turn TITLE on some turns and the terminal reply on others.
- **Opaque:** tool RESULT blobs (`5.4.7.2.1`) use a proprietary codec (constant magic `01 0c 39 d6 c7`; not zlib/gzip/zstd/deflate) — not plaintext-decodable. Reconstruct the human-readable action from the args JSON + `5.30`/`5.31` instead.

The proto wire decoder is **total** (never throws): on any malformed or
truncated payload it stops and returns what parsed so far, so a stub row
(no `5.4` envelope, ~3% of type 5, ~20% of type 17) still yields an
addressable `(cascade_id, idx)` row.

[source: src/sources/gemini/gemini.constants.ts; src/sources/gemini/step-decode.ts; src/sources/gemini/proto-scan.ts; .tmp/gemini-feature/DATA-FORMATS.md; .tmp/gemini-feature/PROTOBUF-FIELDMAP.md]
