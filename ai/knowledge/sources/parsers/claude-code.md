# claude-code Parser

Captures Claude Code session transcripts from `~/.claude/projects/<project>/<session>.jsonl`.

## Files watched

- Base dir: `~/.claude/projects` (`CLAUDE_CODE_PROJECTS_SUBPATH` joined with
  `homedir()`). No platform branching — Claude Code uses `~/.claude` everywhere.
- Main glob: `*/*.jsonl` (`CLAUDE_CODE_GLOB_PATTERN`). One JSONL per session, one
  directory per project.
- Sub-agent glob: `*/*/subagents/*.jsonl` (`CLAUDE_CODE_SUBAGENT_GLOB_PATTERN`).
  Scanned only when the maintainer-only flag `PROXAI_GATEWAY_CAPTURE_SUB_AGENTS` (or
  `PROXAI_GATEWAY_CAPTURE_SUB_AGENTS_CLAUDE_CODE`) is truthy. Default off.
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

## Filtering (`isDialogueRecord`, collect.ts:142)

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
dropped before redaction so it never reaches the wire. `isDialogueRecord` accepts
`parsed: unknown` and narrows it using type guards and checks, staying fully
compliant with the global typescript type safety rules.

## Usage recovery (F1) (`slimClaudeUsageRecord`, collect.ts)

`isDialogueRecord` keeps only visible dialogue, which historically discarded the
per-call `usage` on `tool_use` assistant records (Anthropic bills per request, so
this lost ~75% of Claude token telemetry). Those records are NOT lost: the collect
loop's `else` branch ships a **slim, usage-only projection** via
`slimClaudeUsageRecord` — `{ type:'assistant', sessionId, uuid, timestamp?,
message:{ model?, usage } }` with the bulky tool **content stripped** and `usage`
projected field-by-field into a closed shape (`input_tokens`, `output_tokens`,
`cache_creation_input_tokens`, `cache_read_input_tokens`, `service_tier`). It carries
**no `promptId`**, so nest folds it into the open per-`promptId` turn — **no new
ACRs**. `tool_result`/synthetic/api-error records carry no usage and stay dropped.
Each slim line keeps the source line's `physicalEndOffset`, so watermark continuity
is unchanged (one kept entry per source line, mirroring codex `trimCodexRecord`).

The inspect/consent-surface preview mirrors this: `analyzeJsonlLogFile`
(`poll-worker.ts`) counts the slim record and its slim byte size, so the previewed
"telemetry bytes" match what is actually shipped.

**Forward-only:** records dropped before this change never reached S3, so historical
Claude under-counts are unrecoverable; only captures taken after this ships are
complete.

## Output `NewBatch`

- `sourceApp: 'claude-code'`
- `sourceKind: 'jsonl_append'`
- `bodyFormat: 'jsonl'`
- `watermarkKind: 'byte_range'`
- `watermarkTable: null`
- `sourceInode`: real inode (used as fallback cursor key)
- `agentSchemaVersion`: from `parsed.version` or `parsed.message.version` in any
  kept line (`extractAgentSchemaVersion`, collect.ts:421). Falls back to
  `'unknown'`.

The body is `zstd(redact(filtered_jsonl_text))`. Filtered text is the kept lines
joined with `\n` plus a trailing newline.

## Parser version scheme

There is no parser-internal version — `agentSchemaVersion` is whatever Claude Code
itself wrote into the JSONL. The parser tolerates absence: it scans every kept
line until it finds either field.

## Redaction integration

`applyRedaction` runs **per slice** via `createSliceRedactor` (collect.ts:56), which
  caches `{ redactedBytes, compressed }` per slice in a `WeakMap`. The splitter's
  `measureCompressed` callback returns the cached compressed length, so the splitter
  binary-searches over the same redacted+compressed bytes that ultimately ship.
  Redaction is also run once on the full filtered text (collect.ts:277) only to seed
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
`ai/rules/sources/sources.md`.

## Gotchas

- The `isDialogueRecord` function parameter is typed `parsed: unknown` to respect
  the global typescript rules. It safely narrow-casts internally via type guards.
- Synthetic prefix matching uses `text.trimStart().startsWith(prefix)` — leading
  whitespace is tolerated.
- `physicalEndOffset` in the kept-line tracking is bytes from the start of the
  *range*, not from the start of the file; `watermarkStart + endOffset` reconverts
  to absolute. The last slice forces `endOffset = range.endByte - watermarkStart`
  so the cursor lands exactly at `range.endByte` regardless of how many lines were
  filtered out at the tail.
- Sub-agent flag is read once at module load (`SUB_AGENT_CAPTURE_BY_SOURCE`); a
  daemon restart is required to flip it.

[source: src/sources/claude-code/claude-code.constants.ts:1-13; src/sources/claude-code/discover.ts:14-67; src/sources/claude-code/collect.ts:56-447; src/services/config/sub-agent-flags.ts:1-35]
