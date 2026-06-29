# Phase 6 — Codex re-attach parser guard

- **Status:** ✅ DONE (implemented + reviewed) — nest **PR #231** open (`2ce3845c`); `main` is protected, so it lands via PR
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
- [x] Re-emitted `task_started` for an already-emitted turn is dropped (no smaller-window overwrite).
- [x] Drop metric live + registered.
- [x] In-open-turn duplicate behavior unchanged.
- [x] Tests above green.

## Implementation outcome (2026-06-29)
- **Commit:** `2ce3845c` on branch `feat/codex-reattach-guard-f6` → **nest PR #231** — *fix(codex): drop re-attached task_started for an already-emitted turn (F6)*.
- **Guard:** `codex-parse-chat.service.ts` — a clause added after the `openTurnId` dedup and before the truncated-flush: a `task_started` whose `turn_id === acc.lastEmittedTurnId` is dropped + counted (`continue`), so a *different* open turn is untouched and the dropped re-attach's trailing body lines fall out at the no-open-turn gate (`if (acc.openTurnId === null) continue;`). Catches the **most-recent** emitted turn only (`lastEmittedTurnId` advances, never rewinds; an older-turn re-attach still falls to the F4 upsert backstop). No post-flush continuation recovery (out of scope).
- **Metric:** `agent_gateway_parser_codex_reattach_dropped_total` registered in `metric-kind-registry.ts` (`'counter'`), emitted via `metricAccumulator.recordEvent(name, {agent:'CODEX'})`.
- **Tests:** 2 in `codex-parse-chat.service.spec.ts` — *headline* (full re-emit of an emitted turn → exactly 1 record + counter fires) and *edge* (re-attach while a different turn is open → no `turn_id_mismatch`, both turns preserved). TDD red→green; both proven load-bearing (guard removed → both fail).
- **Verification:** full nest unit suite **8654/8654**, codex + registry 314/314, typecheck 0, lint 0/0, pre-commit metric-cardinality-audit passed. Adversarial plan-review + post-impl code-review both **ready-to-merge** (no Critical/Important).

## Merge checklist
- [ ] proxai_nest **PR #231** merged (open; 2 required status checks) — branch `2ce3845c`

## Orchestrator quick-check (run on "Phase 6 done")
- `grep -n "lastEmittedTurnId" proxai_nest/src/agent-gateway/parsers/codex/services/codex-parse-chat.service.ts`
  → confirm the guard now considers `lastEmittedTurnId`.
- Confirm the drop metric is registered and tested.

## Data-refresh implication
✅ Backfillable via Phase 11 re-parse (combined with Phase 2/4 it recomputes Codex history correctly).
