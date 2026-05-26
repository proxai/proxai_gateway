# gemini-cli Parser

Captures Gemini CLI session JSONL files from `~/.gemini/tmp/<dir>/chats/.../*.jsonl`.
Structurally similar to claude-code but with a mandatory header line that must be
skipped and a subprocess-based version detection.

## Files watched

- Base dir: `~/.gemini/tmp` (`GEMINI_CLI_TMP_SUBPATH`). No platform branching.
- Glob: `*/chats/**/*.jsonl` (`GEMINI_CLI_GLOB_PATTERN`). This **does** include a
  `**` segment — it's the only source glob that does (necessary because Gemini's
  per-chat directory depth is not fixed). The leading `*/` and required `chats/`
  segment still pin enough of the path to avoid catching unrelated files.

## Discovery (`discoverGeminiCliFiles`, discover.ts:20)

1. `statFile(baseDir)` early-return — fresh installs without Gemini use return
   empty.
2. `Bun.Glob.scan({ cwd: baseDir, onlyFiles: true })` over the glob.
3. Per hit: `statFile`, skip if missing or `mtimeMs < minMtimeMs`. Otherwise push
   `{ sourcePath, sourcePathHash (sha256), inode, sizeBytes, lastModifiedMs }`.

No sub-agent path — Gemini CLI does not have a distinct sub-agent directory in
this layout. `SUB_AGENT_CAPTURE_BY_SOURCE['gemini-cli']` exists but the discovery
code does not branch on it.

## Capture format (input)

First line is a **header** (session metadata, never dialogue). Subsequent lines
are per-event JSON objects. Records have `type ∈ {gemini, user, ...}`. Format
details in `ai/knowledge/sources/formats/gemini-cli-format.md`.

## Header handling

This is the load-bearing difference from claude-code/codex JSONL.

- `GEMINI_CLI_HEADER_MAX_BYTES = 64 * 1024` (constants.ts:14) caps the header
  scan.
- `readHeaderEnd` (collect.ts:365) reads up to 64 KiB from byte 0, finds the
  first `\n`, returns the byte **after** it. Returns `null` if no newline within
  64 KiB.
- On a fresh file (`watermarkStart === 0`): if `readHeaderEnd` returns `null`,
  the collector returns early — the file is treated as "header still being
  written, retry next poll". If the header end equals or exceeds file size, the
  cursor is set to `headerEnd` so next poll resumes past it.
- On subsequent polls (`watermarkStart > 0`): the header is already past, and
  `eventStart = watermarkStart` directly.

This is why the rules cascade calls out "fresh Gemini file's cursor must start
past the header, not at 0".

## Filtering (`isGeminiCliDialogueRecord`, collect.ts:52)

- `type === 'gemini'` → kept (model output).
- `type === 'user'` → kept if `content` is not an array, OR if any array item
  has a string `text` field.
- Anything else → dropped.

## Trimming (`trimGeminiCliRecord`, collect.ts:135)

Only `type === 'gemini'` is trimmed:

- `toolCalls[*]`: keep only `id, name, displayName, description, status,
  timestamp, agentId, args`. Truncate `args` string values > 512 bytes to
  `'<trimmed>'`.
- `thoughts[*]`: keep only `subject` and `timestamp`. Full chain-of-thought text
  is dropped before redaction.

`type === 'user'` is passed through verbatim (after the `isDialogueRecord`
filter).

## Version detection (`detectGeminiCliVersion`, version.ts:9)

Unique to Gemini — version is **not** in the file. Instead:

1. `Bun.which('gemini')`. If `null`, version is `null`.
2. `Bun.spawn([resolved, '--version'])` with a 3-second `AbortSignal.timeout`.
3. If exit code 0 and the first non-empty line matches `/^[\w.+:/-]{1,64}$/`,
   return that line.
4. Result is prefixed with `'gemini-cli/'` for `agentSchemaVersion`. Falls back
   to `'gemini-cli/unknown'`.

The collector context exposes `detectVersion?` for tests and for callers that
want to pin the version without spawning a subprocess each poll. In production
no caller overrides it — every Gemini poll spawns `gemini --version`.

## Output `NewBatch`

- `sourceApp: 'gemini-cli'`
- `sourceKind: 'jsonl_append'`
- `bodyFormat: 'jsonl'`
- `watermarkKind: 'byte_range'`
- `watermarkTable: null`
- `sourceInode`: real inode
- `agentSchemaVersion`: `'gemini-cli/<version>'` or `'gemini-cli/unknown'`

## Parser version scheme

The version string is the external `gemini` CLI binary version, prefixed with
`gemini-cli/`. There is no parser-internal version.

## Redaction integration

Per-slice `createSliceRedactor` (collect.ts:38) — same pattern as
claude-code/codex JSONL. The splitter's `measureCompressed` returns cached
compressed bytes so the binary search converges on a slice that fits both the
2 MiB compressed and 10 MiB decompressed budgets.

## Watermark handling

- Cursor key: `(sourceApp='gemini-cli', sourcePathHash, sourceInode, table=null)`.
- Initial watermark: `0`, but the first real cursor write lands at `headerEnd`
  (≥ 1, ≤ 64 KiB+1), never `0`. This is the contract enforced in the rules
  cascade.
- Subsequent writes advance to `range.endByte` (past last complete line).
- The kept-line offset math uses `eventStart` (not `watermarkStart`) as the
  base, so byte ranges remain absolute even on the first capture.

## Dedup

- Monotonic byte watermark per file.
- Header is skipped exactly once (on first poll) — subsequent polls treat
  `eventStart = watermarkStart`, which is already past the header.
- Server: `capture_id` UUIDv7 idempotency.

## Idle-flush behavior

None. Poll-driven (120 s). No "session ended" trigger.

## Error path

Single outer `try/catch`. On throw:

1. Push `{ sourcePath, reason }` to `result.errors`.
2. **Note:** unlike the other parsers, the gemini-cli `catch` block does NOT
   re-write the cursor with bumped `consecutiveErrors`. The error is logged via
   `result.errors`, but the cursor row is left untouched. On the next poll, the
   prior cursor is read and capture re-attempts from the same offset. This
   asymmetry is a deviation from `.claude/rules/sources/sources.md` — the rule
   says "catch-block reads the prior cursor and upserts with `consecutiveErrors:
   priorErrors + 1`". Worth confirming whether this is intentional or a latent
   gap.

`setCursor` calls inside the success path also do not pass `consecutiveErrors`
(they rely on the default), so a previously-bumped counter is not reset on
success either.

## Gotchas

- `isGeminiCliDialogueRecord(parsed: any)` is typed `any` — one of the boundary
  exceptions to the no-`any` rule, alongside claude-code's variant.
- The `**/*.jsonl` middle segment in the glob is the **only** non-pinned-depth
  pattern in the source layer. If Gemini changes its directory layout, this is
  the most likely silent capture-expansion risk.
- Header detection caps at 64 KiB. If a Gemini header ever exceeds 64 KiB
  (currently unobserved), the file would be permanently skipped — `readHeaderEnd`
  returns `null` and the collector returns early without advancing the cursor.
- `gemini --version` subprocess runs on every poll (3 s timeout). For a daemon
  polling four sources every 120 s, that's one extra subprocess per cycle.
- The version regex `/^[\w.+:/-]{1,64}$/` accepts a wide alphabet (slashes,
  colons, plus signs) to tolerate pre-release tags.

[source: src/sources/gemini-cli/gemini-cli.constants.ts:1-15; src/sources/gemini-cli/discover.ts:12-48; src/sources/gemini-cli/collect.ts:52-376; src/sources/gemini-cli/version.ts:9-45]
