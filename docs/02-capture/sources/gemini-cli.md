[← Back to 2.1 Sources](../2.1-sources.md) · [Index](../../README.md) · [Folder: sources](./README.md)

# Gemini CLI — capture decisions and product selections

> Gemini CLI writes one JSONL per chat under `~/.gemini/tmp/<project>/chats/`. The first line of each file is a session-meta header that the gateway skips on a fresh cursor; everything after is event records. The gateway parses each event line, keeps only the user↔assistant dialogue records, trims each assistant record, and ships the result. The recursive `**` glob catches every chat depth Gemini might use in the future.

Of the four supported agents, Gemini CLI has the simplest on-disk shape: one append-only JSONL per chat, no sub-agent concept, no SQLite. Capture is not a raw byte passthrough — the collector parses every event line, applies a dialogue filter (`isGeminiCliDialogueRecord`), and runs each surviving assistant record through `trimGeminiCliRecord` before redaction and shipping. The interesting parts are that dialogue filter/trim pass, the header-skip dance on fresh cursors, and the version-detection path (which spawns the `gemini` binary).

## Where the data lives

| Item | Value |
| --- | --- |
| Base directory | `~/.gemini/tmp` (`GEMINI_CLI_TMP_SUBPATH`) |
| Glob | `*/chats/**/*.jsonl` (`GEMINI_CLI_GLOB_PATTERN`) — recursive `**` under `<project>/chats/` |
| Source kind | `jsonl_append` |
| Body format | `jsonl` |
| Watermark kind | `byte_range` |
| Watermark table required? | No |
| Header max scan budget | `64 KiB` (`GEMINI_CLI_HEADER_MAX_BYTES`) |
| Agent-schema-version prefix | `gemini-cli/` (e.g., `gemini-cli/0.3.4`) |
| Schema version fallback | `gemini-cli/unknown` |

On-disk shape:

```
~/.gemini/tmp/
└── <project-slug>/
    └── chats/
        └── session-<YYYY-MM-DDTHH-mm>-<hex>.jsonl
```

The `**` part of the glob is intentional: Gemini occasionally re-org chats under sub-directories of `<project>/chats/` and the recursive depth absorbs it without a discovery change. On the inspected laptop, all 261 jsonl files lived directly at `<project>/chats/*.jsonl`; the `**` was redundant in practice but is the right hedge.

### Why `**` here and pinned-depth elsewhere?

Claude Code uses pinned-depth globs to surface "unknown layout" as discovery silence (fail-closed). Gemini CLI uses a recursive `**` because the existing layout already nests one extra directory level for some chat sub-types (e.g., `<project>/chats/<sub-folder>/session-*.jsonl`) and the cost of slurping a non-transcript JSONL is bounded — the receiver's record-shape check rejects anything that doesn't look like a Gemini line.

The trade-off is "fail-open" — fewer surprises if Gemini adds another nesting level, more surface for unexpected `.jsonl` files to leak through. So far no such files have shown up.

## What gets captured

| What | Captured? | Notes |
| --- | --- | --- |
| Every chat JSONL under `<project>/chats/**/` | **Yes** | Recursive glob; one cursor per file. |
| Header line (first newline-terminated record) | **Skipped on fresh cursor** | `readHeaderEnd` finds the first `\n` and seeds the initial watermark to the offset after it. The header itself is never shipped. |
| `gemini` event records (assistant turns) | **Yes, trimmed** | Always kept by `isGeminiCliDialogueRecord`; each one is passed through `trimGeminiCliRecord` before shipping. |
| `user` event records with text content | **Yes, unchanged** | Kept only when `content` is a non-array, or an array carrying at least one item with a string `text` field. Shipped without trimming. |
| `user` records with no text content | **No** | A `user` record whose `content` array carries only non-text items (functionResponse, inlineData, etc.) is dropped. |
| `thought`, `tool_call`, `info`, and every other event type | **No** | Dropped by `isGeminiCliDialogueRecord`. |
| Agent schema version | Best-effort | Spawns `gemini --version` once on daemon start (`defaultSpawn`); falls back to `gemini-cli/unknown`. |

The collector reads the byte range from `eventStart` to EOF, splits it on `\n`, and `JSON.parse`s each non-empty line. A line is kept only when `isGeminiCliDialogueRecord(parsed)` returns true; lines that fail to parse are silently skipped. Kept lines are re-serialized (`gemini` records via `trimGeminiCliRecord`), joined with `\n`, redacted, compressed, and shipped. The watermark still advances to the physical end of the consumed byte range even when every line in a cycle is filtered out — dropped content is not re-scanned.

### Files under `~/.gemini/` that are NOT captured

| Path | What it is | Why skipped |
| --- | --- | --- |
| `~/.gemini/history/<project>/.project_root` | Single-line project-path marker | Not transcript content. |
| `~/.gemini/history/zsh`, `.../sounds`, `.../<other>` | Shell-history-style traces tagged by project | Not transcript content. |
| `~/.gemini/extensions/<name>/` | Installed extension data | Application state. |
| `~/.gemini/antigravity-browser-profile/` | Browser-profile state for one of Gemini's tools | Application state. |
| `~/.gemini/oauth_creds.json`, `google_accounts.json`, `installation_id`, `trustedFolders.json`, `settings.json`, `state.json`, `extension_integrity.json` | Credentials / config | Not transcript content; not safe to ship. |
| `~/.gemini/GEMINI.md` | Per-user system-instructions file | Not auto-shipped (user-owned config); the system prompt the model actually sees is captured through Gemini's emitted line stream. |
| `~/.gemini/projects.json`, `~/.gemini/tmp/bin/`, `~/.gemini/tmp/background-processes/` | Project index, vendored tools, process-lifecycle traces | Out of scope. |

Glob scope: only `~/.gemini/tmp/<project>/chats/**/*.jsonl` matches; everything else is invisible to discovery.

## What's inside a captured chat file

Every chat file has two kinds of line:

### Line 1 — session-meta header

```json
{"sessionId":"<uuid>","projectHash":"<sha256>","startTime":"<iso>","lastUpdated":"<iso>","kind":"main"}
```

The gateway uses this only on a fresh cursor: it scans the first `64 KiB` of the file (capped by `GEMINI_CLI_HEADER_MAX_BYTES`) for the first `\n`, sets the initial watermark to the offset after it, and stores that as `watermark_end`. The header line itself is **not** shipped as a body — its role is to define the start-of-events boundary. The session-level metadata it carries is reconstructed by the receiver from the event lines' `sessionId` field.

If no newline is found within 64 KiB, header scanning gives up and capture is skipped for that file for this cycle. The next cycle retries.

### Line 2 onward — event records

Gemini writes several event types into the JSONL. The collector keeps only two of them:

| `type` | Role | Payload | Capture |
| --- | --- | --- | --- |
| `user` | User turn | `content` (array or string), `timestamp`, `id` | **Kept when text-bearing**, shipped unchanged |
| `gemini` | Assistant turn | `content`, `model`, `tokens`, `toolCalls`, `thoughts` | **Always kept**, trimmed by `trimGeminiCliRecord` |
| `thought` | Pre-response reasoning | `thoughts` (text), `model` | **Dropped** |
| `tool_call` | Tool invocation envelope | `toolCalls` (array), `id`, `timestamp` | **Dropped** |
| `info` | Lifecycle / status envelope | Per-event payload (model switch, file edit, etc.) | **Dropped** |

Common fields across all event types: `id`, `timestamp`, `type`. The dialogue filter (`isGeminiCliDialogueRecord`) decides what survives:

- `type === 'gemini'` — always kept.
- `type === 'user'` — kept only when its `content` is a non-array value, or an array containing at least one object with a string `text` field. A `user` record whose content array has no text item (e.g. functionResponse or inlineData payloads only) is dropped.
- Every other type (`thought`, `tool_call`, `info`, …) — dropped.

#### How `trimGeminiCliRecord` shrinks an assistant record

Each kept `gemini` record is passed through `trimGeminiCliRecord` before shipping. The trim is a shallow copy of the record (so `id`, `timestamp`, `type`, `content`, `model`, `tokens`, and any other top-level fields ride along unchanged) with the `toolCalls` and `thoughts` arrays rewritten:

| Field | Trim behavior |
| --- | --- |
| `toolCalls[]` | Each call is reduced to an allow-list: `id`, `name`, `displayName`, `description`, `status`, `timestamp`, `agentId`, plus an `args` object. The `result`, `resultDisplay`, and `renderOutputAsMarkdown` fields are dropped from every tool call. |
| `toolCalls[].args` | String values longer than `512` bytes (`GEMINI_ARG_VALUE_MAX_BYTES`) are replaced with the literal `"<trimmed>"`. Shorter strings and non-string values pass through. |
| `thoughts[]` | Each entry is reduced to `{subject, timestamp}`. |

`user` records are shipped exactly as parsed — `trimGeminiCliRecord` is a no-op for any record whose `type` is not `gemini`.

`kind` is observed only at the session-meta header level. All chats inspected so far have `kind:"main"` — no `subagent` / `child` variant has been seen. **Gemini CLI does not have a native sub-agent transcript concept** at the inspected version.

## How the body lands on the wire

| Field | Value |
| --- | --- |
| `body_format` | `jsonl` |
| `body_compression` | `zstd` (level 3) |
| Body content | The `gemini` and text-bearing `user` records that pass `isGeminiCliDialogueRecord`, each `gemini` record trimmed by `trimGeminiCliRecord`, re-serialized one record per line and `\n`-joined, after redaction. Not a raw byte slice of the source file. |
| Watermark | `byte_range`, `(start, end)` are absolute byte offsets into the chat file. |
| Header treatment | Not included in any batch's body; only its terminating `\n` offset feeds the initial watermark. |

The body is rebuilt, not copied. The collector parses every event line in the byte range, drops the non-dialogue lines, trims each assistant record, and `JSON.stringify`s the survivors back into a fresh JSONL document. Watermark offsets, however, still track the **physical** source file: `watermark_start` / `watermark_end` are absolute byte offsets into the chat JSONL, mapped back from the kept lines' physical end offsets so the cursor advances correctly even though the shipped bytes differ from the on-disk bytes. When a size split occurs, each batch's watermark span covers the physical source region that produced that slice's records.

If a cycle parses lines but every one is filtered out, no batch is shipped — the cursor still advances to the physical end of the consumed range so the dropped lines are not re-scanned.

The header skip happens once per file lifetime — once the cursor has been seeded, the daemon reads from `watermark_end` and never re-reads the header. If the file is rotated (new inode at the same path), the new cursor row starts at 0 again and the header-skip dance repeats.

## How the receiver parses the body

Gemini CLI parser-side support in the receiver (`proxai_nest`) is **not yet implemented** as a per-source parser folder (no `proxai_nest/src/agent-gateway/parsers/gemini-cli/` exists today). Captured Gemini bytes land in `agent_raw_captures` with `source_app = 'gemini-cli'` and stay there until a parser is added.

The receiver-side acceptance contract that **is** in place:

- `gemini-cli` is a declared `source_app` in `SOURCE_VARIANTS` (`services/contract/contract.constants.ts`).
- `receive-validate.service.ts` accepts Gemini batches and writes them to `agent_raw_captures`.
- Watermarks are tracked per `(source_path_hash, watermark_table='')`.
- Server-side watermark sync returns Gemini watermarks alongside the other sources.

So Gemini chat content is captured and durably stored on the receiver; it just isn't yet projected into `agent_call_records`. When the per-source parser ships, it can replay from `agent_raw_captures` without changes on the gateway side.

## Per-source quirks

- **Header-skip is the only special path in the collect function.** Everything else is the standard jsonl byte-range read. The first capture of a file scans for the leading `\n`; subsequent captures read straight from `watermark_end`.
- **64 KiB header budget is a hard cap.** A header that exceeds 64 KiB (which would mean the entire `sessionId` / `projectHash` / `startTime` envelope expanded past that) is treated as "no header found" and capture is skipped for the cycle. Observed header sizes on real files are ~200–400 bytes; the cap is effectively defensive.
- **Version detection spawns the `gemini` binary.** `defaultSpawn(['gemini', '--version'])` runs once on daemon start; the result is validated against `/^[\w.+:/-]{1,64}$/` and prefixed with `gemini-cli/`. If `gemini` is not on `PATH` (CI runners frequently lack it), `defaultWhich('gemini')` returns null and the version falls back to `gemini-cli/unknown`. The `defaultSpawn` and `defaultWhich` helpers are exported precisely so coverage of these branches doesn't depend on having `gemini` installed (see canonical reference at `src/sources/gemini-cli/version.ts`).
- **No `agentId` analog.** Gemini doesn't emit a sub-agent discriminator field; if it ever introduces one, the gateway will need a receiver-side change (line content inspection), not a discovery-side change.
- **Recursive glob is fail-open.** If Gemini adds non-chat JSONL under `<project>/chats/<somewhere>/`, those files would be picked up. So far this hasn't happened.
- **Sub-agent flag is wired but no-op.** `PROXAI_GATEWAY_CAPTURE_SUB_AGENTS_GEMINI_CLI` resolves correctly and is observable via `SUB_AGENT_CAPTURE_BY_SOURCE['gemini-cli']`, but `discoverGeminiCliFiles` does not branch on it. Gemini's `invoke_agent` tool stores prompt + final result inline in the parent chat as a single `toolCall` entry; the sub-agent's intermediate turns are never persisted by Gemini to any file the gateway can discover. The flag is present for symmetry with the other sources and to land cleanly if a future Gemini version persists deeper data. See [6.4 Maintainer Debug Flags](../../06-operations/6.4-maintainer-debug-flags.md).

## Skipped-content reality check

| Concern | Status |
| --- | --- |
| Are we discovering every chat file? | Yes. Every JSONL file under `<project>/chats/**/` is discovered; recursive `**` covers any depth Gemini might use. |
| Are we capturing every event line? | No — by design. The collector keeps the user↔assistant dialogue (`gemini` records and text-bearing `user` records) and drops `thought`, `tool_call`, and `info` lifecycle envelopes. |
| Are we keeping full tool-call payloads? | No. Each kept tool call is reduced to an identity/status allow-list; `result`, `resultDisplay`, and `renderOutputAsMarkdown` are dropped, and `args` string values over 512 bytes become `"<trimmed>"`. |
| Are we keeping full reasoning? | No. `thought` records are dropped entirely, and each `thoughts[]` entry on a kept `gemini` record is reduced to `{subject, timestamp}`. |
| Are we missing sub-agent intermediate turns? | Yes — but they are not persisted by Gemini itself. `invoke_agent` keeps only the prompt + final result inline in the parent chat's `toolCall`. There is no on-disk artifact to capture, with or without the flag. |
| Are we missing system prompts? | The user-supplied `~/.gemini/GEMINI.md` file is not captured (it's user config). The system prompt **as actually sent to the model** would appear in the event stream only if Gemini emits it as a `gemini` or text-bearing `user` record; if it rides on an `info` envelope, it is dropped by the dialogue filter. |
| Are we missing config / credentials? | Yes, by design — `oauth_creds.json`, `google_accounts.json`, `settings.json`, etc. are excluded from discovery. |
| Are we missing application diagnostics? | Yes, by design — `~/.gemini/extensions/`, `~/.gemini/antigravity-browser-profile/`, the project history files. |

Capture is a deliberate dialogue projection, not a complete copy of the chat JSONL. The collector keeps the user↔assistant turns and drops tool-result bodies, rendered displays, oversized tool-call args, `thought` reasoning, and the `tool_call` / `info` lifecycle envelopes. Like [Cursor](./cursor.md), Gemini capture trades transcript completeness for a leaner, dialogue-focused body. The receiver-side gap is separate: the per-source parser is not yet implemented in `proxai_nest` (see below).

[← Back to 2.1 Sources](../2.1-sources.md) · [Index](../../README.md) · [Folder: sources](./README.md)
