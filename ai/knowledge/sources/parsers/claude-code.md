# claude-code Parser

Captures Claude Code session transcripts from `~/.claude/projects/<project>/<session>.jsonl`.

## Files watched

- Base dir: `~/.claude/projects` (`CLAUDE_CODE_PROJECTS_SUBPATH` joined with
  `homedir()`). No platform branching — Claude Code uses `~/.claude` everywhere.
- Main glob: `*/*.jsonl` (`CLAUDE_CODE_GLOB_PATTERN`). One JSONL per session, one
  directory per project.
- Sub-agent glob: `*/*/subagents/*.jsonl` (`CLAUDE_CODE_SUBAGENT_GLOB_PATTERN`).
  Scanned only when the maintainer-only flag `PROXAI_GATEWAY_CAPTURE_SUB_AGENTS` (or
  `_CLAUDE_CODE`) is truthy. Default off.
- Pinned depth — never `**/*.jsonl`. Two passes are de-duplicated via a `seen` set
  on absolute path.

## Discovery (discover.ts:23)

`discoverClaudeCodeFiles(baseDir, { minimumMtime, captureSubAgents })`:

1. `statFile(baseDir)` → return empty array if absent (fresh install with no Claude
   Code use).
2. Walk `CLAUDE_CODE_GLOB_PATTERN` with `Bun.Glob.scan({ onlyFiles: true })`.
3. For each hit: `statFile`, skip if missing or `mtimeMs < minMtimeMs`.
4. Optionally run the sub-agent glob with the same filter, skipping any path
   already seen.
5. Each kept entry is described as `{ sourcePath, sourcePathHash (sha256), inode,
   sizeBytes, lastModifiedMs }`.

## Capture format (input)

Per-line JSON objects, one record per line. Records have `type: 'user'`,
`type: 'assistant'`, or other meta types. Format details live in
`ai/knowledge/sources/formats/claude-code-format.md`.

## Filtering (`isDialogueRecord`, collect.ts:93)

Only `type === 'user'` and `type === 'assistant'` rows survive, and only when:

- `parsed.isMeta !== true`
- Content (looked up in order: `message.content`, `content`, `message.text`, `text`)
  has at least one non-empty text part.
- For `user`: the first text is NOT a Claude synthetic prefix
  (`<bash-input>`, `<bash-stdout>`, `<bash-stderr>`, `<local-command-stdout>`,
  `<local-command-stderr>`, `<command-name>`, `<command-message>`, `<command-args>`,
  `<system-reminder>`, `<local-command-caveat>`), AND content contains no
  `tool_result` part.
- For `assistant`: `message.model !== '<synthetic>'`, `isApiErrorMessage !== true`,
  AND content contains no `tool_use` part.

Everything else (synthetic prompts, tool plumbing, summaries, meta lines) is
dropped before redaction so it never reaches the wire. `isDialogueRecord` is the
boundary the sources rule explicitly carves out from the no-`any` rule — its
parameter is typed `parsed: any` deliberately and is the one tolerated exception in
the rule cascade.

## Output `NewBatch`

- `sourceApp: 'claude-code'`
- `sourceKind: 'jsonl_append'`
- `bodyFormat: 'jsonl'`
- `watermarkKind: 'byte_range'`
- `watermarkTable: null`
- `sourceInode`: real inode (used as fallback cursor key)
- `agentSchemaVersion`: from `parsed.version` or `parsed.message.version` in any
  kept line (`extractAgentSchemaVersion`, collect.ts:405). Falls back to
  `'unknown'`.

The body is `zstd(redact(filtered_jsonl_text))`. Filtered text is the kept lines
joined with `\n` plus a trailing newline.

## Parser version scheme

There is no parser-internal version — `agentSchemaVersion` is whatever Claude Code
itself wrote into the JSONL. The parser tolerates absence: it scans every kept
line until it finds either field.

## Redaction integration

`applyRedaction` runs **per slice** via `createSliceRedactor` (collect.ts:34), which
caches `{ redactedBytes, compressed }` per slice in a `WeakMap`. The splitter's
`measureCompressed` callback returns the cached compressed length, so the splitter
binary-searches over the same redacted+compressed bytes that ultimately ship.
Redaction is also run once on the full filtered text (collect.ts:272) only to seed
`extractAgentSchemaVersion`.

## Watermark handling

- Initial watermark: `0` (read everything from byte 0). No header skip — Claude
  Code's JSONL starts with a real dialogue line.
- `getCursorWithFallback` keys on `(sourceApp, sourcePathHash, sourceInode,
  watermarkTable=null)`. Inode is the fallback key for path-changed-but-same-file
  cases.
- After a successful capture, cursor is set to `range.endByte` (advances past the
  last complete line in the slice; partial trailing line is left for next cycle).
- If `file.sizeBytes <= watermarkStart`, the parser returns early. Same when
  `readJsonlRange` returns 0 bytes.

## Dedup

Two layers:

1. Discovery-level: `seen` set on absolute path prevents double-scanning when both
   main and sub-agent globs match.
2. Capture-level: monotonic byte watermark per `(sourcePathHash, inode)` means a
   given byte range is never re-uploaded as long as the cursor row exists. Server
   dedupes on `capture_id` (UUIDv7) as a backstop.

## Idle-flush behavior

There is none. The parser is poll-driven (capture cycle = 120 s default). On each
poll: if the file has not grown since last cursor, nothing happens. If it has, the
new bytes are read, filtered, and shipped. There is no debounce, no inactivity
timer, no "session ended" hook — long-lived sessions get incrementally shipped
every cycle.

## Error path

On any throw inside `collectClaudeCodeFile`, the catch block:

1. Pushes `{ sourcePath, reason }` into `result.errors`.
2. Re-reads the prior cursor (best-effort).
3. Calls `setCursor` with the **same** `watermarkEnd` and `consecutiveErrors:
   priorErrors + 1`.

The success path always sets `consecutiveErrors: 0`. This is the canonical "bump
on failure, clear on success" pattern referenced in
`.claude/rules/sources/sources.md`.

## Gotchas

- The `isDialogueRecord(parsed: any)` signature is the one place `any` is kept
  deliberately. Don't widen to `unknown` without a rewrite — the rule cascade
  documents this as intentional. (`sources.md` rule.)
- Synthetic prefix matching uses `text.trimStart().startsWith(prefix)` — leading
  whitespace is tolerated.
- `physicalEndOffset` in the kept-line tracking is bytes from the start of the
  *range*, not from the start of the file; `watermarkStart + endOffset` reconverts
  to absolute. The last slice forces `endOffset = range.endByte - watermarkStart`
  so the cursor lands exactly at `range.endByte` regardless of how many lines were
  filtered out at the tail.
- Sub-agent flag is read once at module load (`SUB_AGENT_CAPTURE_BY_SOURCE`); a
  daemon restart is required to flip it.

[source: src/sources/claude-code/claude-code.constants.ts:1-13; src/sources/claude-code/discover.ts:14-66; src/sources/claude-code/collect.ts:93-430; src/services/config/sub-agent-flags.ts]
