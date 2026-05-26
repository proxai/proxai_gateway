---
name: add-source-parser
description: Step-by-step scaffold for adding a new coding-agent source to the gateway.
---

# Add Source Parser

## When to use

Use any time a new agent source (e.g., a new CLI tool) needs to be captured. Triggered by requests like "add support for X CLI", "capture Y's session files".

## Key files

- `src/sources/<agent>/discover.ts`, `collect.ts`, `index.ts`, `<agent>.constants.ts`
- `src/services/contract/contract.constants.ts` (SOURCE_VARIANTS)
- `src/services/polling/default-sources.ts`, `poll-worker.ts`

## Common pitfalls

- Using `**/*.jsonl` instead of a pinned-depth glob.
- Forgetting to add the `SOURCE_VARIANTS` entry — `validateRawRecordDTO` will reject the DTO silently at runtime.
- Not implementing `consecutive_errors` tracking in the catch block.
- Not handling VACUUM detection if the source is sqlite-based.
- Opening a live sqlite directly instead of using `snapshotSqlite` (for sources the agent writes to concurrently).
- Using `any` in the type signatures — prohibited across the codebase.
