[← Back to 2.1 Sources](../2.1-sources.md) · [Index](../../README.md) · [Folder: sources](./README.md)

# Claude Code — capture decisions and product selections

> What the gateway watches under `~/.claude/projects/`, which lines it keeps, which it drops before upload, and how the receiver turns the kept lines into records.

Claude Code writes its transcripts as append-only JSONL files under `~/.claude/projects/`. Each project gets its own directory; each chat gets its own file; each sub-agent spawn gets its own file inside a `subagents/` subdirectory of its parent session. The gateway parses every JSONL line in a session file, keeps only the lines that pass the `isDialogueRecord` filter (user and assistant dialogue turns that carry real text), and ships those kept lines verbatim — each as its full original JSONL line, after redaction. Tool-call, tool-result, meta, synthetic, and non-dialogue envelope lines are dropped before upload.

## Where the data lives

| Item | Value |
| --- | --- |
| Base directory | `~/.claude/projects` (`CLAUDE_CODE_PROJECTS_SUBPATH`) |
| Parent-session glob | `*/*.jsonl` (`CLAUDE_CODE_GLOB_PATTERN`) |
| Sub-agent glob | `*/*/subagents/*.jsonl` (`CLAUDE_CODE_SUBAGENT_GLOB_PATTERN`) |
| Source kind | `jsonl_append` |
| Body format | `jsonl` |
| Watermark kind | `byte_range` |
| Watermark table required? | No |

On-disk shape that the two globs target:

```
~/.claude/projects/
├── <project-slug>/
│   ├── <sessionId>.jsonl                         ← parent session
│   └── <sessionId>/
│       └── subagents/
│           └── agent-<hex>.jsonl                 ← sub-agent session
```

Both globs are pinned-depth (not `**/*.jsonl`). A future Claude Code release that buries JSONL deeper produces zero new matches rather than silently slurping unknown content; the operational expectation is "discovery silence" as the failure signal.

## What gets captured

`collectClaudeCodeFile` reads the new byte range of a session file, splits it on `\n`, and `JSON.parse`s every non-blank line. A line is kept only when `isDialogueRecord(parsed)` returns true. Kept lines are re-joined and shipped as their full original JSONL line — there is no field-level trimming for Claude Code. Lines that fail the filter, fail to parse, or are blank are dropped before upload.

`isDialogueRecord` keeps a record only when **all** of these hold:

- top-level `type` is `user` or `assistant`;
- `isMeta` is not `true`;
- it carries non-empty text content — checked across `message.content`, `content`, `message.text`, and `text`, whether the value is a string, a single text block object, or an array of blocks;
- for `user` records: the first text block is not a synthetic command/tooling wrapper, and the content carries no `tool_result` block;
- for `assistant` records: `message.model` is not `<synthetic>`, `isApiErrorMessage` is not `true`, and the content carries no `tool_use` block.

A `user` record's first text block is treated as synthetic when (after trimming leading whitespace) it starts with any of: `<bash-input>`, `<bash-stdout>`, `<bash-stderr>`, `<local-command-stdout>`, `<local-command-stderr>`, `<command-name>`, `<command-message>`, `<command-args>`, `<system-reminder>`, `<local-command-caveat>`.

| What | Captured? | Notes |
| --- | --- | --- |
| `user` dialogue turns with real text | **Yes** | Kept when not `isMeta`, not a synthetic command-echo, and carrying no `tool_result` block. Shipped as the full original JSONL line. |
| `assistant` dialogue turns with real text | **Yes** | Kept when not `isMeta`, model is not `<synthetic>`, not an API-error message, and carrying no `tool_use` block. Shipped as the full original JSONL line. |
| Sub-agent JSONL files | **No** by default — re-enabled via maintainer flag | The sub-agent glob `*/*/subagents/*.jsonl` is gated behind `PROXAI_GATEWAY_CAPTURE_SUB_AGENTS` (global) or `PROXAI_GATEWAY_CAPTURE_SUB_AGENTS_CLAUDE_CODE` (per-source). When enabled, the same `isDialogueRecord` filter applies to those files. See [6.4 Maintainer Debug Flags](../../06-operations/6.4-maintainer-debug-flags.md). |
| File rotation / deletion | Handled | `(source_path_hash, source_inode)` keys the cursor; a new inode at the same path produces a fresh cursor at `watermark_end = 0`. |
| Agent schema version | Best-effort | Parses `version` / `message.version` from the kept (redacted) lines; falls back to `unknown` if not found. |

## What gets skipped

The filter drops two distinct classes of content: lines inside a captured session file that fail `isDialogueRecord`, and files that the discovery globs never match.

Dropped lines inside a captured file:

| What | Skipped because |
| --- | --- |
| Tool-call records | `assistant` records whose content carries a `tool_use` block fail the filter. |
| Tool-result records | `user` records whose content carries a `tool_result` block fail the filter. |
| Meta records | Any `user` / `assistant` record with `isMeta === true` fails the filter. |
| Synthetic command-echo records | `user` records whose first text block starts with a synthetic wrapper prefix (`<bash-input>`, `<command-name>`, `<system-reminder>`, etc.) fail the filter. |
| Synthetic-model assistant records | `assistant` records with `message.model === '<synthetic>'` fail the filter. |
| API-error assistant records | `assistant` records with `isApiErrorMessage === true` fail the filter. |
| Empty / textless `user` / `assistant` records | Records with no non-empty text content fail the filter. |
| Every non-`user`/`assistant` envelope type | `system`, `attachment`, `ai-title`, `custom-title`, `summary`, `compacting`, and any other `type` value fail the filter outright. |
| Lines that are blank or fail `JSON.parse` | Skipped silently; the watermark still advances past them. |

Files the discovery globs never match:

| What | Skipped because |
| --- | --- |
| Files at the projects root (e.g., `~/.claude/projects/foo.jsonl`) | Glob requires at least one directory level; Claude Code never writes here. |
| Files deeper than the two supported shapes (`<project>/<session>/foo.jsonl`, `<project>/x/y/z/foo.jsonl`) | Not part of Claude Code's known layout. Pinned-depth design — see test `rejects deeper-nested jsonl files outside the two pinned-depth shapes`. |
| Non-`.jsonl` files in project dirs | Glob requires the `.jsonl` extension. |
| Files older than `initial_scan_window_days` (default 30) | mtime filter at discovery time; user-overridable via config. |
| Other `~/.claude/` content (`history.jsonl`, settings, statsig payloads, todos cache, etc.) | Outside the projects subpath. Not transcript content. |

## What's inside a captured JSONL line

A captured line is the full, unmodified JSONL record for a `user` or `assistant` dialogue turn — no field is stripped. Only `user` and `assistant` lines reach the wire; every other `type` value is dropped by the filter. The receiver's record-type taxonomy (`proxai_nest/.../claude-code.utils.ts`) still recognises the broader envelope set, but only the two dialogue types are present in a Claude Code batch:

| `type` field | Role | In a captured batch? | Notes |
| --- | --- | --- | --- |
| `user` | User turn | Yes (filtered) | `message.content` is a string or an array of text blocks. Tool-result and synthetic command-echo `user` records are dropped before upload. |
| `assistant` | Assistant turn | Yes (filtered) | `message.content` carries text blocks. Tool-call (`tool_use`), synthetic-model, and API-error `assistant` records are dropped before upload. |
| `attachment`, `system`, `ai-title`, `custom-title`, `permission-mode`, `last-prompt`, `summary`, `compacting`, others | Envelope / metadata | No | Non-dialogue envelope types fail `isDialogueRecord` and never reach the wire. |

Sub-agent JSONL lines additionally carry an `agentId` field — the hex from the filename `agent-<hex>.jsonl`. Empirically: parent transcripts have 0% of records with `agentId`; sub-agent transcripts have 100%. The receiver uses this field (not the path) to compose the composite chat id (see below).

The version probe (`extractAgentSchemaVersion`) walks the kept, redacted lines looking for a top-level `version` or `message.version` string and writes it onto every batch as `agent_schema_version`.

## How the body lands on the wire

| Field | Value |
| --- | --- |
| `body_format` | `jsonl` |
| `body_compression` | `zstd` (level 3) |
| Body content | The kept `user` / `assistant` lines that passed `isDialogueRecord`, re-joined with `\n` and shipped verbatim as their original JSONL lines, **after** redaction. |
| Watermark | `byte_range`, `(start, end)` are absolute byte offsets into the source file — they span the full physical range the kept lines were read from, including the dropped lines in between. |
| Batch cap | 2 MiB compressed / 10 MiB decompressed (`services/contract`). Oversize jsonl bodies split on `\n` boundaries. |

The gateway parses every line to decide what to keep, but it does not rewrite the content of a kept line: each kept line ships as its original JSON text, modified only by the redaction stage (which scans the bytes for secrets / api-key patterns and writes back). When a byte range contains no dialogue lines, no batch is emitted and the watermark advances past the range. Record-level interpretation of the kept lines is the receiver's job.

## How the receiver parses the body

The receiver's pipeline for Claude Code:

1. **Receive + validate.** `receive-validate.service.ts` decompresses the zstd body, splits on `\n`, and persists each line into `agent_raw_captures`.
2. **Extract chats.** `ClaudeCodeExtractChatsService` groups lines into `ChatBundle`s. The bundle's `chatId` is composed as:
   - `chatId = sessionId` for parent transcripts (no `agentId` on any line).
   - `chatId = sessionId:agentId` for sub-agent transcripts (every line carries the same `agentId`).
3. **Parse chat.** `ClaudeCodeParseChatService` walks the bundle in stream order, builds turns from the `user` / `assistant` dialogue records the gateway forwarded, and persists per-turn state to `agent_parse_states` (keyed by `chatId`, so parent + sub-agent of the same session never collide).
4. **Finalize turn.** `claude-code-finalize-turn.service.ts` writes one `agent_call_records` row per turn with `chat_id` and `agent_id` (the latter is `null` for parent rows, the hex sub-agent id for sub-agent rows).

Database identity: `(chat_id, agent_id)`. Dashboards query sub-agents via the partial index `idx_acr_chat_id_agent_id_partial WHERE agent_id IS NOT NULL` (migration `20260512093153_acr_subagent_id_and_drift_cleanup`).

## Per-source quirks

- **Sub-agent linkage is in line content, not path shape.** Even though the path layout differs (sub-agent files sit two directories deeper than parents), the receiver pulls the discriminator from the JSONL line's `agentId` field. The path layout difference is purely a discovery concern; downstream is path-agnostic.
- **The two globs are structurally disjoint.** A file path matches exactly one of them; the discover function dedupes by absolute source path defensively, but the dedupe branch is unreachable through the public API today.
- **Compaction summaries (`summary` / `compacting` lines) never reach the wire.** These are non-dialogue envelope types; `isDialogueRecord` drops them at capture time, so they are not present in any Claude Code batch.
- **Schema-version detection is degradation-safe.** If the parser can't find a `version` field, the batch still ships with `agent_schema_version = "unknown"`; nothing in the pipeline blocks on it.

## Skipped-content reality check

For Claude Code the gateway forwards only `user` and `assistant` dialogue turns that carry real text. Everything else a session file contains is left behind:

- **Tool-call and tool-result records.** `assistant` records with a `tool_use` block and `user` records with a `tool_result` block are dropped. The dialogue around tool use survives; the structured tool payloads do not.
- **Synthetic command-echo records.** `user` records whose first text block is a tooling wrapper (`<bash-input>`, `<command-name>`, `<system-reminder>`, and the rest of the prefix list) are dropped. These are Claude Code's own command plumbing, not human-typed prompts.
- **Meta, synthetic-model, and API-error records.** `isMeta` records, `assistant` records with `message.model === '<synthetic>'`, and `assistant` records with `isApiErrorMessage === true` are dropped.
- **Non-dialogue envelope types.** `system`, `attachment`, `ai-title`, `custom-title`, `summary`, `compacting`, and every other `type` value never reach the wire.
- **Sub-agent transcripts.** One JSONL file per `Task` tool invocation inside a session. The orchestrator's auto-generated prompts to the sub-agent and the sub-agent's intermediate turns are stored as `role:"user"` and `role:"assistant"` lines, indistinguishable from human-typed prompts to a naive parser. The product position is that this internal back-and-forth is noise relative to the user-visible conversation. Maintainers debugging the gateway can re-enable sub-agent capture per the rules in [6.4 Maintainer Debug Flags](../../06-operations/6.4-maintainer-debug-flags.md); when enabled, the same `isDialogueRecord` filter still applies to those files. End users have no surface for this.

Other "skipped" data:

- Files outside the two pinned-depth shapes (none observed in current Claude Code releases).
- Non-transcript Claude Code artifacts (`~/.claude/history.jsonl`, `~/.claude/settings.json`, statsig caches, todos files) which are not transcript content by any definition.

This contrasts with [Cursor](./cursor.md), where the byte-volume gap is much larger and the missing content has different characteristics.

[← Back to 2.1 Sources](../2.1-sources.md) · [Index](../../README.md) · [Folder: sources](./README.md)
