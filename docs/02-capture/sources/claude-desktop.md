[← Back to 2.1 Sources](../2.1-sources.md) · [Index](../../README.md) · [Folder: sources](./README.md)

# Claude Desktop — capture decisions and product selections

*Last Updated: 2026-06-01*

> What the gateway watches under `~/Library/Application Support/Claude/local-agent-mode-sessions/`, how it correlates the desktop audit log with the CLI transcript, which records it keeps, and how it reshapes them before upload.

Claude Desktop's **Cowork** mode (the sandboxed agent loop inside the desktop GUI, distinct from the terminal CLI) writes an authoritative `audit.jsonl` per session. The gateway watermarks that audit file, keeps only genuine `user`/`assistant` dialogue (via the shared `isDialogueRecord` filter), enriches each kept record with CLI metadata correlated from the matching `.claude/projects` transcript, stamps `source_platform = "claude-cowork-desktop"`, and ships the reshaped lines after redaction. It is the only source that reads **two** on-disk files to produce one record stream.

## Where the data lives

| Item | Value |
| --- | --- |
| Base directory | Platform-specific user data root plus `local-agent-mode-sessions` (`CLAUDE_DESKTOP_SESSIONS_DIR`) |
| Audit glob (File B, authoritative) | `*/*/local_*/audit.jsonl` (`CLAUDE_DESKTOP_AUDIT_GLOB_PATTERN`) |
| Transcript glob (File A, enrichment) | `.claude/projects/*/*.jsonl` (`CLAUDE_DESKTOP_TRANSCRIPT_GLOB_PATTERN`, scanned relative to the session dir) |
| Source kind | `jsonl_append` |
| Body format | `jsonl` |
| Watermark kind | `byte_range` |
| Watermark table required? | No |

The base directory resolves based on the host operating system:
- **macOS:** `~/Library/Application Support/Claude/local-agent-mode-sessions`
- **Windows:** `%APPDATA%\Claude\local-agent-mode-sessions` (falling back to `~/AppData/Roaming/Claude/local-agent-mode-sessions` if `%APPDATA%` is missing)
- **Linux:** `${XDG_CONFIG_HOME:-~/.config}/Claude/local-agent-mode-sessions`

On-disk shape that the audit glob targets:

```
<Base Directory>/
└── <a>/
    └── <b>/
        └── local_<id>/
            └── audit.jsonl          ← discovered, watermarked, shipped (File B)
```

The audit glob is pinned-depth (not `**/audit.jsonl`). A future Claude Desktop release that relocates the audit file produces zero new matches rather than silently capturing unknown content; "discovery silence" is the failure signal.

`audit.jsonl` (**File B**) is the record stream. The `.claude/projects/*/*.jsonl` transcripts (**File A**) are a read-only side input scanned from the same session directory — they carry the CLI metadata (`cwd`, `version`, `gitBranch`, `sessionId`) the desktop audit log lacks, and are never watermarked or shipped on their own.

## What gets captured

`collectClaudeDesktopFile` reads the new byte range of the audit file, builds the CLI-metadata maps from the session's File A transcripts, then `JSON.parse`s every non-blank audit line. A line is kept only when `isDialogueRecord(parsed)` returns true **and** `parsed.isReplay !== true`. Kept records are reshaped (below), re-joined, and shipped after redaction.

`isDialogueRecord` is the same filter Claude Code uses — a record is kept only when **all** hold:

- top-level `type` is `user` or `assistant`;
- `isMeta` is not `true`;
- it carries non-empty text content (checked across `message.content`, `content`, `message.text`, `text`);
- for `user` records: the first text block is not a synthetic command/tooling wrapper, and the content carries no `tool_result` block;
- for `assistant` records: `message.model` is not `<synthetic>`, `isApiErrorMessage` is not `true`, and the content carries no `tool_use` block.

| What | Captured? | Notes |
| --- | --- | --- |
| `user` dialogue turns with real text | **Yes** | Same `isDialogueRecord` rules as Claude Code. Enriched with File A metadata correlated by `uuid`. |
| `assistant` dialogue turns with real text | **Yes** | Enriched with File A metadata correlated by `message.id`. |
| Replay records (`isReplay === true`) | **No** | The desktop app replays the session on open; replays are not new dialogue. |
| File A transcripts on their own | **No** | Read only to enrich File B audit records; never shipped or watermarked. |
| Sub-agent capture | No-op | `PROXAI_GATEWAY_CAPTURE_SUB_AGENTS_CLAUDE_DESKTOP` is wired but `discoverClaudeDesktopFiles` does not branch on it. See [6.4 Maintainer Debug Flags](../../06-operations/6.4-maintainer-debug-flags.md). |
| File rotation / deletion | Handled | `(source_path_hash, source_inode)` keys the cursor; a new inode at the same path produces a fresh cursor at `watermark_end = 0`. |
| Agent schema version | Best-effort | `claude-desktop/<File A version>` for the first kept record; falls back to `unknown`. |

## How the gateway reshapes each kept record

Unlike Claude Code (which ships lines verbatim), Claude Desktop **mutates** each kept record before upload:

| Transform | Detail |
| --- | --- |
| Merge CLI metadata | Looks up File A metadata — `user` by `uuid`, `assistant` by `message.id` — and sets `cwd`, `gitBranch`, `cliSessionId` (from `sessionId`), `agentVersion` (from `version`). |
| Rename audit keys | `session_id` → `desktopSessionId`; `client_platform` → `clientPlatform`. |
| Inject platform tag | `source_platform = "claude-cowork-desktop"` is added to every kept record (Phase 1 body-embedding; see [Source Platform Conventions](../../../ai/knowledge/sources/source-platform-conventions.md)). |

Because the emitted shape differs from the raw on-disk line, any change to these transforms is a parser-shape change and requires an `agent_schema_version` bump.

## Sidecar CLI Tracking

Claude Desktop cowork sessions can spin up sidecar CLI processes. The gateway tracks these CLI sessions using metadata files stored under a dedicated directory in the user data root:
- **Sidecar directory:** `claude-code-sessions` (`CLAUDE_DESKTOP_SIDECAR_DIR`)
- **Sidecar glob pattern:** `*/*/local_*.json` (`CLAUDE_DESKTOP_SIDECAR_GLOB_PATTERN`)

The `loadDesktopCliSessionIds` function scans this directory for files matching the glob pattern. It parses each JSON file, extracts the `cliSessionId` field, and compiles a set of active desktop CLI session IDs.

This set is passed to the Claude Code collector context as `desktopCliSessionIds`. When processing a Claude Code session, the collector determines the `source_platform` by checking if the session's ID is in the sidecar set:
- **Matched:** `claude-code-desktop` (meaning the session was run inside Claude Desktop's cowork CLI wrapper)
- **Unmatched:** `claude-code-cli` (meaning the session was run as a standalone Claude Code CLI command)

## How the body lands on the wire

| Field | Value |
| --- | --- |
| `body_format` | `jsonl` |
| `body_compression` | `zstd` (level 3) |
| Body content | The kept, reshaped `user` / `assistant` records, re-joined with `\n`, **after** redaction. |
| Watermark | `byte_range`; `(start, end)` are absolute byte offsets into `audit.jsonl`, spanning the full physical range the kept records were read from (including dropped lines in between). |
| Batch cap | 2 MiB compressed / 10 MiB decompressed (`services/contract`). Oversize jsonl bodies split on `\n` boundaries via `splitJsonlAtBoundary`. |

When a byte range contains no kept records (e.g. replay-only or tool-only ranges), no batch is emitted and the cursor still advances to `range.endByte` so the range is never re-scanned. Initial watermark is `0` — the audit file starts with a real record, so there is no header to skip.

## Per-source quirks

- **Two-file correlation.** `audit.jsonl` is authoritative for dialogue; the `.claude/projects` transcript supplies CLI context. If the transcript is missing or a record doesn't correlate, the record still ships — just without the merged `cwd`/`gitBranch`/`agentVersion` fields.
- **Cross-platform support.** Although Claude Desktop is most commonly used on macOS, the discoverer implements platform-specific path resolution for macOS (`darwin`), Windows (`win32`), and Linux/Unix.
- **In-process polling, not a worker.** `claude-desktop` is a registered default source but is **not** routed through the capture cycle's Bun-Worker shortcut (only `claude-code`, `cursor`, `codex` are). It runs on the main thread via its in-process poller. The `inspect` dry-run command, however, scans it inside the worker's `handleInspect`. See [4.1 Capture Cycle](../../04-daemon-loops/4.1-capture-cycle.md).
- **`source_platform` is body-embedded (Phase 1).** It is injected inside the record body, not promoted to a top-level DTO column yet — see [Source Platform Conventions](../../../ai/knowledge/sources/source-platform-conventions.md).
- **Schema-version detection is degradation-safe.** No correlated version → `agent_schema_version = "unknown"`; nothing in the pipeline blocks on it.

## What gets skipped

| What | Skipped because |
| --- | --- |
| Tool-call / tool-result records | Fail `isDialogueRecord` (same as Claude Code). |
| Meta / synthetic / API-error records | Fail `isDialogueRecord`. |
| Replay records | `isReplay === true` is dropped explicitly. |
| File A transcripts as captures | Used only for enrichment; never a capture target. |
| Files outside the pinned audit glob | `*/*/local_*/audit.jsonl` requires the exact depth; anything else is invisible. |
| Files older than the mtime threshold (if specified) | mtime filter at discovery time (`minimumMtime`). |
| Missing user data / session directories | Base path does not exist on the system; discovery returns empty. |

This contrasts with [Claude Code](./claude-code.md), which ships dialogue lines verbatim with no metadata merge, and with [Cursor](./cursor.md), whose body is a trimmed sqlite KV snapshot.

[← Back to 2.1 Sources](../2.1-sources.md) · [Index](../../README.md) · [Folder: sources](./README.md)
