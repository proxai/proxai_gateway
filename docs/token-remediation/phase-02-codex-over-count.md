# Phase 2 — Codex over-count fix (F2)

- **Status:** ⬜ NOT STARTED
- **Severity:** 🔴 high · **Effort:** M
- **Repos:** proxai_nest
- **Depends on:** none · **Blocks:** Phase 11 (re-parse backfill recomputes Codex history)
- **Source:** VERIFICATION_FINDINGS.md §3, §9, §11.1 · IMPLEMENTATION_PLAN.md Rank 2

## Concern this phase eliminates
Codex OVER-counts input + cache-read tokens. `aggregateUsage` unconditionally SUMS every `token_count` event's
`last_token_usage` with no advancement/dedup guard, so re-emitted frames (turn-boundary re-emission AND
rate-limit-only re-emits, which repeat the same `total_token_usage`) are double-counted. ~9% over-count on
multi-turn sessions. When merged, a turn's tokens reflect true inference, not re-emitted duplicates.

## Background (read first)
- `src/agent-gateway/parsers/codex/codex.utils.ts:341-363` — sums `last_token_usage` across ALL token_count
  events; `nonCachedInput = max(0, input − cached)` `:354-358`; `cache_creation` null `:379`.
- `src/agent-gateway/parsers/codex/services/codex-parse-chat.service.ts:280-296` — a `token_count` has no
  `turn_id`, so it attaches to the most-recent open turn; dedup exists ONLY for duplicate `task_started`
  (`:233-242`), never for `token_count`.
- The fix is acknowledged-and-deferred ("v6 §A2") at `codex-finalize-turn.service.ts:308-325`.
- Stale docstring to fix: `src/agent-gateway/parsers/codex/extractors/usage.ts:4-8` claims "use latest" but the
  code SUMS — reconcile it.

## Change spec
### proxai_nest
- Replace blind summing with **cumulative-total diff**: turn input/cache =
  `total_token_usage(end) − total_token_usage(start)` so re-emitted/rate-limit frames are naturally excluded.
  - Alternative: keep delta-summing but DROP a turn's first `token_count` when its `total_token_usage` has not
    advanced past the prior turn's end.
- Handle the edges (verifier must confirm each):
  - cross-tick start/end totals → persist prior-turn cumulative anchors across ticks (the deferred piece);
    reconcile with `flushOpenTurn` truncated turns (`codex-parse-chat.service.ts:244-262`).
  - missing `total_token_usage` block → defined fallback.
- Update the stale `extractors/usage.ts:4-8` docstring to describe the actual semantics.
- Files: `codex.utils.ts:341-363`; `extractors/usage.ts:4-28,67-74`;
  `services/codex-parse-chat.service.ts:244-262,280-298`; `codex-finalize-turn.service.ts:305-326`.

## Tests (verifier checks these)
- A 2-turn rollout where turn 2's first `token_count` re-emits turn 1's final `total_token_usage`: assert the
  stored turn-2 input == `total_end − total_start`, NOT the naive sum (the canonical 18,800 over-count case from
  VERIFICATION_FINDINGS §3.1).
- A single-turn session: stored tokens == final `total_token_usage` (no over-count).
- A rate-limit-only re-emit within a turn (unchanged `total_token_usage`): not double-counted.
- Missing-`total_token_usage` fallback path covered.

## Acceptance criteria (100% = all true)
- [ ] Multi-turn sessions no longer add the prior turn's final call into the next turn.
- [ ] Rate-limit-only re-emits are excluded.
- [ ] Cross-tick partial-turn captures handled (anchors persisted) — no new under-count introduced.
- [ ] Stale `extractors/usage.ts:4-8` docstring corrected.
- [ ] Tests above green; existing codex specs still green.

## Merge checklist
- [ ] proxai_nest PR merged

## Orchestrator quick-check (run on "Phase 2 done")
- `grep -n "total_token_usage" proxai_nest/src/agent-gateway/parsers/codex/codex.utils.ts` → confirm the
  cumulative-diff (or advancement-guard) logic is present.
- Confirm the over-count regression test exists and asserts the `total_end − total_start` result.
- Confirm `extractors/usage.ts` docstring no longer says "use latest" while code sums.

## Data-refresh implication
✅ **Backfillable.** Codex `token_count` events are in S3. Phase 11 re-parses to recompute historical Codex
tokens with the corrected logic.
