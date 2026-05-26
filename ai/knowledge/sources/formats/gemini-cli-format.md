# gemini-cli File Format

Gemini CLI writes one JSONL file per chat under
`~/.gemini/tmp/<chat-dir>/chats/.../<file>.jsonl`. The exact directory depth
between `chats/` and the file is not fixed — that's why the discovery glob uses
a `**` segment (the only `**` in the source layer).

## Header line

The **first line** of every Gemini CLI JSONL is a header record (session
metadata, not dialogue). The parser must skip it on first capture and resume
from the byte immediately after the first `\n`.

- Skip happens only when `watermarkStart === 0` (i.e., first time we touch this
  file).
- Constant cap: `GEMINI_CLI_HEADER_MAX_BYTES = 64 * 1024` bytes.
  `readHeaderEnd` (collect.ts:365) reads up to 64 KiB and finds the first `\n`.
- If no newline within 64 KiB, the file is treated as "header still in flight"
  — collector returns early and retries on the next poll. The cursor is **not**
  written, so the file stays at `watermarkStart === 0` until the header is
  complete.
- If the header end is the entire file size, the cursor is written to
  `headerEnd` (the event stream is empty so far).

This is the only source that requires a non-zero initial watermark; the rules
cascade enforces it (`.claude/rules/sources/sources.md`).

## Event lines

After the header, each subsequent line is an event record with a `type` field.

### Kept line types (`isGeminiCliDialogueRecord`, collect.ts:52)

| `type`     | Extra condition                                  | Behavior |
| ---------- | ------------------------------------------------ | -------- |
| `gemini`   | (none)                                           | Kept; trimmed (see below) |
| `user`     | `content` is not an array, OR any array item has a string `text` field | Kept verbatim |
| (anything) | —                                                | Dropped |

### `gemini` record trimming (`trimGeminiCliRecord`, collect.ts:135)

Two arrays inside a `gemini` record get reshaped before serialization:

- `toolCalls[]`: each call is reduced to
  `{ id, name, displayName, description, status, timestamp, agentId, args }`.
  `args` string values > 512 bytes become `'<trimmed>'`. Other fields are
  removed.
- `thoughts[]`: each thought is reduced to `{ subject, timestamp }`. Full
  thought text never ships.

Other fields on the `gemini` record (parts, finishReason, model, etc.) pass
through unfiltered.

### `user` records

Passed through verbatim once they survive the filter. No trimming. If `content`
is a plain string or absent (non-array), the record is kept; if it's an array,
at least one item must carry a `text: string` field.

## Version contract

Gemini does **not** embed the CLI version in the file. Instead, on every poll,
the collector spawns `gemini --version` (3 s timeout, resolved via `Bun.which`),
takes the first non-empty line, validates against `/^[\w.+:/-]{1,64}$/`, and
emits `'gemini-cli/<version>'` as `agentSchemaVersion`. Fallback is the literal
`'gemini-cli/unknown'`.

If `gemini` is not on `PATH` (`Bun.which` returns `null`), or the subprocess
fails or times out, the fallback fires — capture still proceeds.

## Encoding and line discipline

- UTF-8.
- `\n`-terminated. `readJsonlRange` caps at the last complete newline, so
  partial trailing records are held until the next poll.
- `JSON.parse` failures per line are silently dropped (the byte offset still
  advances).

## Body shape

The body is `zstd(redact(filtered_jsonl_text))` — the same JSONL envelope as
claude-code and codex rollouts (each kept line is `JSON.stringify(trimmed)`
joined by `\n` with a trailing newline). `bodyFormat = 'jsonl'`.

## Path identity

- `sourcePath` is the absolute path to the chat file.
- `sourcePathHash = sha256(sourcePath)`.
- `sourceInode` is populated (real inode).

Gemini does not rotate or vacuum these files in any observed scenario — they're
append-only. There is no VACUUM detection path for gemini-cli.

## Subagents

Gemini CLI does not have a separate sub-agent transcript layout. The discovery
code does not check the sub-agent flag, and there is no second glob.

[source: src/sources/gemini-cli/gemini-cli.constants.ts:8-15; src/sources/gemini-cli/discover.ts:20-48; src/sources/gemini-cli/collect.ts:52-376; src/sources/gemini-cli/version.ts:9-45]
