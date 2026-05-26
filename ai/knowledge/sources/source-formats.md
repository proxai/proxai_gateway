# Source Formats

- Five `SOURCE_VARIANTS` covering four agents (codex appears twice). Source: `contract.constants.ts`, lines 40-75.
- `jsonl_append` + `byte_range` watermark: Claude Code (`*/*.jsonl`), Codex rollouts (`sessions/*/*/*/rollout-*.jsonl`), Gemini CLI (`*/chats/**/*.jsonl`).
- `sqlite_kv_snapshot` + `rowid_range`: Cursor (`state.vscdb` files — global + per-workspace). Key prefix allow-list: `composerData:`, `bubbleId:`, `agentKv:blob:`.
- `sqlite_table_snapshot` + `rowid_range` + `watermark_table`: Codex state (`state_*.sqlite`, highest-numbered only). Table allow-list: `threads`, `thread_spawn_edges`.
- Cursor reads use `snapshotSqlite` (Bun snapshot API) to avoid blocking the live writer. Codex state opens read-only with a double-attempt fallback: if `openReadOnly` throws, retry with `{ immutable: true }`.
- Gemini CLI header skip: `GEMINI_CLI_HEADER_MAX_BYTES = 64 KiB` (in `gemini-cli.constants.ts`). First watermark end is set past the header, not at 0.
- Codex rollout discovery pre-queries `thread_spawn_edges` from the state sqlite to build a set of child-thread rollout paths and skips them by default (sub-agent flag off). Errors opening the state DB produce an empty set (fail-open).
- Agent schema version detection: claude-code parses `version`/`message.version` from kept lines; gemini-cli spawns `gemini --version` and validates against `/^[\w.+:/-]{1,64}$/` with `gemini-cli/` prefix.
- VACUUM detection (for sqlite sources): `detectVacuum` in `services/buffer/vacuum-detect.ts` triggers on any of: `size_decreased`, `page_count_decreased`, `rowid_regressed`. On trigger, source path gets `#gen-N` suffix + rehash; fresh cursor at `watermark_end = 0`.
