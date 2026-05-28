---
name: "Source Parser Layout and Behavior"
description: "Directory structures, file glob depths, sqlite cursor snapshots, and error tracking for source parsers."
activation: "contextual"
scenarios: ["Creating a new source parser", "Modifying discover.ts or collect.ts in source apps", "Implementing custom file scanners or cursor persistence"]
globs: ["src/**/*.ts", "**/*.ts"]
---

# Source Parser Rules


- Each source lives in `src/sources/<app>/` with exactly `discover.ts`, `collect.ts`, `index.ts` (+ `<app>.constants.ts`, `<app>.types.ts`). Match this layout for new sources.
- Never use `**/*.jsonl` globs — all source globs are pinned-depth (e.g., `*/*.jsonl`, `*/*/subagents/*.jsonl`). Changing glob depth risks silently capturing unknown content.
- `discoverXxxFiles` must accept `{ minimumMtime?: Date | null }` and pass `minMtimeMs` to the glob walker so the initial-scan window is respected.
- Cursor reads must go through `snapshotSqlite` (never open the live `state.vscdb` directly) so the agent's writer is never blocked.
- Codex state discovery always picks the highest-numbered `state_*.sqlite` only; never iterate older state files.
- `isDialogueRecord` (claude-code) takes `parsed: unknown` — do not widen to `any`. If a type guard is needed, narrow explicitly with `typeof`/`in` checks.
- Per-source `collect` functions must maintain `consecutive_errors` on the cursor: catch-block reads the prior cursor and upserts with `consecutiveErrors: priorErrors + 1`; success path upserts with `consecutiveErrors: 0`.
- The five `SOURCE_VARIANTS` in `contract.constants.ts` are the canonical enumeration of valid `(sourceApp, sourceKind, bodyFormat, watermarkKind, watermarkTableRequired)` tuples. Never add a source without a matching entry there validated by `validateRawRecordDTO`.
- The `PROXAI_GATEWAY_CAPTURE_SUB_AGENTS*` env-var flags are maintainer-only and must not appear in CLI `--help`, `config.toml`, or README. They are read once at module load (`sub-agent-flags.ts`); a daemon restart is required to change them.
- Gemini CLI: always skip the header line (`GEMINI_CLI_HEADER_MAX_BYTES = 64 KiB` cap) on first capture. The cursor for a fresh Gemini file must start at the byte after the header, not at 0.
