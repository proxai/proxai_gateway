# claude-desktop File Format

`claude-desktop` captures the **Claude Desktop GUI "Cowork"** sessions — the
sandboxed agent-loop sessions that run inside the Claude Desktop app (not the
terminal CLI). It is the only source that correlates **two on-disk files** to
produce one enriched record stream.

## The two files

| Role | Glob (relative to a session dir) | Purpose |
| --- | --- | --- |
| **File B — authoritative audit** | `*/*/local_*/audit.jsonl` (`CLAUDE_DESKTOP_AUDIT_GLOB_PATTERN`) | The dialogue stream the gateway discovers, watermarks, and ships. |
| **File A — CLI metadata transcript** | `.claude/projects/*/*.jsonl` (`CLAUDE_DESKTOP_TRANSCRIPT_GLOB_PATTERN`, scanned `dot: true`) | Read-only side input for enrichment; never watermarked or shipped on its own. |

File B (`audit.jsonl`) is the record stream. File A transcripts carry the CLI
metadata (`cwd`, `version`, `gitBranch`, `sessionId`) that the desktop audit log
does not, so the collector reads File A purely to enrich File B records.

## Base directory (cross-platform)

Resolved cross-platform by `defaultClaudeDesktopSessionsRoot()`, which joins `claudeDesktopUserDataRoot()` with `local-agent-mode-sessions`:
- **macOS**: `~/Library/Application Support/Claude/local-agent-mode-sessions`
- **Windows**: `%APPDATA%/Claude/local-agent-mode-sessions` (falls back to `~/AppData/Roaming/Claude/local-agent-mode-sessions`)
- **Linux**: `$XDG_CONFIG_HOME/Claude/local-agent-mode-sessions` (falls back to `~/.config/Claude/local-agent-mode-sessions`)

## Correlation (collect.ts)

`loadCliMetadataMap(sessionDir)` scans every File A transcript in the discovered
file's session directory and builds two maps:

- `userMap`: keyed by `rec.uuid` for `type: 'user'` records.
- `assistantMap`: keyed by `rec.message.id` for `type: 'assistant'` records.

Each map value is `{ cwd, version, gitBranch, sessionId }`. When a File B record
is kept, the collector looks it up — user records by `parsed.uuid`, assistant
records by `parsed.message.id` — and merges the metadata in.

## Line filter

Reuses claude-code's `isDialogueRecord` (imported from `sources/claude-code`):
only `type ∈ {user, assistant}` with non-empty text survive; tool-call,
tool-result, meta, synthetic, and API-error records are dropped. **One extra
drop rule:** records with `isReplay === true` are skipped (desktop replays the
session on open; replays are not new dialogue).

## Record shape transforms (this parser rewrites the body)

Unlike claude-code (which ships lines verbatim), claude-desktop **mutates each
kept record** before shipping:

- Merges CLI metadata: sets `cwd`, `gitBranch`, `cliSessionId` (from File A
  `sessionId`), and `agentVersion` (from File A `version`).
- Renames audit keys: `session_id` → `desktopSessionId`,
  `client_platform` → `clientPlatform`.
- Injects `source_platform = 'claude-cowork-desktop'` (see
  `source-platform-conventions.md`).

Because the emitted shape differs from the raw on-disk line, any change to these
transforms is a parser-shape change under
`ai/rules/sources/parser-version-bump-required.md`.

## Version field

`agentSchemaVersion` is taken from the first kept record's merged `agentVersion`
(i.e. File A's `version`), prefixed: `claude-desktop/<version>`. Falls back to
the default schema version `'claude-desktop/v2'` (`CLAUDE_DESKTOP_DEFAULT_AGENT_SCHEMA_VERSION`) when no
correlated version is found.

## Sidecar sessions

Claude Desktop can run standard Claude Code as a sidecar process. The sidecar CLI session IDs are stored in JSON files under the `claude-code-sessions` directory (`CLAUDE_DESKTOP_SIDECAR_DIR` = `'claude-code-sessions'`) within the user data root.
- Glob pattern: `*/*/local_*.json` (`CLAUDE_DESKTOP_SIDECAR_GLOB_PATTERN`)
- Extraction: `loadDesktopCliSessionIds` reads these files and extracts `cliSessionId` to return a set of active desktop CLI session IDs.
- Integration: These session IDs are threaded into `claude-code` capture logic to mark their `sourcePlatform` as `'claude-code-desktop'` instead of `'claude-code-cli'`.

## Encoding and line discipline

- UTF-8 (`TextDecoder('utf-8', { fatal: false })`).
- One JSON object per line, `\n`-terminated. `readJsonlRange` caps the slice at
  the last complete newline, so a partial trailing record is held until the next
  poll.
- Per-line `JSON.parse` failures are swallowed; the line is dropped and the byte
  offset still advances.

## On-disk path identity

The full `audit.jsonl` path is hashed (sha256) as `sourcePathHash`; the file
inode is the fallback cursor key. The cursor advances even when a byte range
yields zero kept records, so empty/replay-only ranges are not re-scanned.

[source: src/sources/claude-desktop/collect.ts; src/sources/claude-desktop/discover.ts; src/sources/claude-desktop/sidecar.ts; src/sources/claude-desktop/claude-desktop.constants.ts; ai/knowledge/sources/source-platform-conventions.md]
