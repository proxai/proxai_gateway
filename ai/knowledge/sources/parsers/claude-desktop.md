# claude-desktop Parser

Captures **Claude Desktop GUI "Cowork"** agent-loop sessions by watermarking the
authoritative `audit.jsonl` and enriching each kept record with CLI metadata
correlated from `.claude/projects` transcripts in the same session directory.

## Files watched

- Base dir: `~/Library/Application Support/Claude/local-agent-mode-sessions`
  (`CLAUDE_DESKTOP_SESSIONS_SUBPATH` joined with `homedir()`). No platform branch
  — effectively macOS-only (the path only exists where Claude Desktop runs).
- Discovery glob (File B, authoritative): `*/*/local_*/audit.jsonl`
  (`CLAUDE_DESKTOP_AUDIT_GLOB_PATTERN`). Pinned depth — never `**/audit.jsonl`.
- Enrichment glob (File A, side input): `.claude/projects/*/*.jsonl`
  (`CLAUDE_DESKTOP_TRANSCRIPT_GLOB_PATTERN`, scanned `dot: true` relative to each
  discovered file's session dir). Not watermarked or shipped on its own.

## Discovery (discover.ts)

`discoverClaudeDesktopFiles(baseDir, { minimumMtime })`:

1. `statFile(baseDir)` → return empty array if absent (no Claude Desktop install).
2. Walk `CLAUDE_DESKTOP_AUDIT_GLOB_PATTERN` with `Bun.Glob.scan({ onlyFiles: true })`.
3. For each hit: `statFile`, skip if missing or `mtimeMs < minMtimeMs`.
4. Each kept entry is `{ sourcePath, sourcePathHash (sha256), inode, sizeBytes,
   lastModifiedMs }`.

Note: discovery does **not** take a `captureSubAgents` option — the
`PROXAI_GATEWAY_CAPTURE_SUB_AGENTS_CLAUDE_DESKTOP` flag is wired in
`SUB_AGENT_CAPTURE_BY_SOURCE` but no code branches on it, so it is a no-op today.

## Two-file correlation (the distinctive trait)

Before filtering, `loadCliMetadataMap(sessionDir)` scans every File A transcript
in the discovered file's directory and builds `userMap` (keyed by `uuid`) and
`assistantMap` (keyed by `message.id`), each holding `{ cwd, version, gitBranch,
sessionId }`. Kept File B records are matched against these maps and enriched.

## Filtering

Reuses claude-code's `isDialogueRecord` — only `user`/`assistant` dialogue with
real text survives; tool-call, tool-result, meta, synthetic, and API-error
records drop. **Extra rule:** `isReplay === true` records are skipped (desktop
replays the session on open).

## Output `NewBatch`

- `sourceApp: 'claude-desktop'`
- `sourceKind: 'jsonl_append'`
- `bodyFormat: 'jsonl'`
- `watermarkKind: 'byte_range'`
- `watermarkTable: null`
- `sourceInode`: real inode (fallback cursor key)
- `agentSchemaVersion`: `claude-desktop/<File A version>` for the first kept
  record, else `'unknown'`.

Each kept record is **rewritten** before shipping (this differs from claude-code,
which ships verbatim):

- merges `cwd`, `gitBranch`, `cliSessionId`, `agentVersion` from File A;
- renames `session_id` → `desktopSessionId`, `client_platform` → `clientPlatform`;
- injects `source_platform = 'claude-cowork-desktop'`.

The body is `zstd(redact(rewritten_jsonl_text))`. Redaction runs **per slice**:
`splitJsonlAtBoundary` binary-searches the largest slice that fits the 2 MiB
compressed / 10 MiB decompressed budgets, measuring with `redactSlice` so the
splitter sizes the same redacted+compressed bytes that ship.

## Parser version scheme

`agentSchemaVersion` is derived from the upstream Claude version (File A
`version`) with a `claude-desktop/` prefix. Because the parser actively
**reshapes** the record (key renames, metadata merge, `source_platform`
injection), any change to those transforms requires a parser-shape bump per
`ai/rules/sources/parser-version-bump-required.md`.

## Watermark handling

- Initial watermark: `0`. No header skip — `audit.jsonl` starts with a real
  record.
- `getCursorWithFallback` keys on `(sourceApp, sourcePathHash, sourceInode,
  watermarkTable=null)`.
- After capture, cursor is set to `range.endByte`. If filtering keeps zero
  records, the cursor still advances to `range.endByte` so replay-only / non-
  dialogue ranges are not re-scanned.
- `file.sizeBytes <= watermarkStart` (or a 0-byte range) returns early.

## Worker vs in-process

`claude-desktop` is a registered default source (`buildDefaultSources`) but is
**not** worker-dispatched for capture: the capture cycle's worker shortcut only
routes `claude-code`, `cursor`, `codex` to Bun Workers, so `claude-desktop` runs
through its in-process poller (`makeClaudeDesktopSourcePoller` → `source.poll`)
on the main thread. The `inspect` dry-run command, by contrast, scans
`claude-desktop` inside `handleInspect`.

## Error path

On any throw inside `collectClaudeDesktopFile`, the catch block pushes
`{ sourcePath, reason }` into `result.errors`. Successful captures set the cursor
with `consecutiveErrors: 0`.

[source: src/sources/claude-desktop/claude-desktop.constants.ts; src/sources/claude-desktop/discover.ts; src/sources/claude-desktop/collect.ts; src/services/polling/poll-claude-desktop.ts; src/services/polling/capture-cycle.ts; src/services/config/sub-agent-flags.ts]
