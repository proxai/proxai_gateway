# Phase 6 — Codex re-attach parser guard

- **Status:** ⬜ NOT STARTED
- **Severity:** 🟠 medium · **Effort:** S
- **Repos:** proxai_nest
- **Depends on:** Phase 4 (the upsert guard is the backstop; this is the targeted source-side fix) · **Blocks:** —
- **Source:** VERIFICATION_FINDINGS.md §11.2 · IMPLEMENTATION_PLAN.md Rank 6

## Concern this phase eliminates
A re-emitted `task_started{X}` for an already-flushed turn opens a FRESH turn with the same `X`, because the
duplicate-`task_started` guard checks only `acc.openTurnId` (cleared post-flush), not `lastEmittedTurnId`. The
re-opened turn aggregates only post-flush `token_count` deltas (no S3 replay), producing a smaller token sum that
the shared upsert then writes over the original (higher watermark). Population: the **134 `turn_aborted` + 2
`idle_timeout`** prod Codex flushes. When merged, a post-flush `task_started` re-attach for an
already-emitted turn is dropped (no-op) and counted, instead of silently under-counting.

## Background (read first)
- Dup guard: `proxai_nest/src/agent-gateway/parsers/codex/services/codex-parse-chat.service.ts:233-242`
  (checks `acc.openTurnId` only).
- No S3 replay on re-open: `:166-173` (uses `iterateChunkLines` when `openTurnId` null on tick entry).
- New-turn anchor: `:271`.
- Gemini is structurally immune (truncated/runaway flush drops the offending step rather than continuing it) —
  this is Codex-specific.

## Change spec
### proxai_nest
- Extend the duplicate-`task_started` guard at `:236` to ALSO ignore (or alarm on)
  `newTurnId === acc.lastEmittedTurnId` — so a `task_started` for an already-flushed/emitted turn does not open a
  fresh post-flush-only turn that overwrites the original.
- Emit a metric on this drop so the abort-replay population is sized (register in
  `src/telemetry/metric-kind-registry.ts`).

## Tests (verifier checks these)
- A rollout: turn X is aborted/flushed (ACR emitted), then a later capture re-emits `task_started{X}` followed by
  fewer token_count events → assert the re-emitted X is dropped (no second smaller-window ACR), counter
  increments, original ACR's tokens preserved.
- Regression: an in-open-turn duplicate `task_started` (the already-handled case at `:233-242`) still behaves as
  before.

## Acceptance criteria (100% = all true)
- [ ] Re-emitted `task_started` for an already-emitted turn is dropped (no smaller-window overwrite).
- [ ] Drop metric live + registered.
- [ ] In-open-turn duplicate behavior unchanged.
- [ ] Tests above green.

## Merge checklist
- [ ] proxai_nest PR merged

## Orchestrator quick-check (run on "Phase 6 done")
- `grep -n "lastEmittedTurnId" proxai_nest/src/agent-gateway/parsers/codex/services/codex-parse-chat.service.ts`
  → confirm the guard now considers `lastEmittedTurnId`.
- Confirm the drop metric is registered and tested.

## Data-refresh implication
✅ Backfillable via Phase 11 re-parse (combined with Phase 2/4 it recomputes Codex history correctly).
