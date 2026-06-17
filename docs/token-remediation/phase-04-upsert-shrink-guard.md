# Phase 4 — Upsert shrink-guard (overwrite corruption)

- **Status:** ⬜ NOT STARTED
- **Severity:** 🔴 high · **Effort:** M
- **Repos:** proxai_nest
- **Depends on:** none (recommended before Phase 5/6) · **Blocks:** —
- **Source:** VERIFICATION_FINDINGS.md §10.3, §11.2, §11.3 · IMPLEMENTATION_PLAN.md Rank 4

## Concern this phase eliminates
A higher-watermark re-emit of an existing ACR (same deterministic id) can overwrite ALL ~30 columns — including
the 4 token columns AND `final_text`/`result_content`/`stop_reason`/`user_input_content` — with a SMALLER
post-flush token window, because the upsert is gated solely by `EXCLUDED.last_capture_watermark_end > existing`.
This phase adds a guard that refuses a watermark-advancing UPDATE that strictly SHRINKS the turn's tokens.
**One guard neutralizes three problems at once:** the Codex `task_started` re-attach under-count (Phase 6's
scenario, primary live case per pre-flight), defense-in-depth for the Claude Code idle case, and the broad
content-column corruption.

## Background (read first)
- The shared upsert: `proxai_nest/src/agent-gateway/parse/services/parse-batch-upsert.service.ts:504-545` —
  `ON CONFLICT (id) DO UPDATE SET <~30 cols> = EXCLUDED.*` (token cols `:515-518`) gated by
  `WHERE ... EXCLUDED.last_capture_watermark_end > agent_call_records.last_capture_watermark_end` (`:540-545`).
- **Pre-flight (re-confirm in-phase):** idle-flush advances the SAME `agent_parse_states.last_processed_watermark`
  the main parser reads (`parse-process-chat.service.ts:355-399`), so the Claude Code *same-promptId* overwrite
  is unlikely; the live case is the **Codex re-attach** (new post-flush captures with a re-emitted `task_started`
  produce a smaller-window ACR — see Phase 6). The guard covers both regardless.

## Change spec
### proxai_nest
- In `parse-batch-upsert.service.ts:504-545`, extend the `ON CONFLICT DO UPDATE ... WHERE` so the UPDATE is
  refused when it would strictly shrink tokens, e.g. add:
  `AND (EXCLUDED.input_tokens + EXCLUDED.output_tokens) >= (agent_call_records.input_tokens + agent_call_records.output_tokens)`
  (treat NULLs as 0 with COALESCE; keep the existing watermark condition).
  - Alternative/inclusive option: when re-emitting the same `promptId`/`turnId`, MERGE usage (max or sum per
    semantics) instead of replace.
- Emit a metric/log when a write is rejected for shrinking, so the population is observable (size it in prod).
- Confirm the guard does not block legitimate corrections (e.g. a genuine larger re-parse must still win).

## Tests (verifier checks these)
- Upsert with `EXCLUDED.watermark > existing` AND smaller `input+output` → UPDATE is REJECTED; existing row
  unchanged (tokens AND content columns preserved).
- Upsert with larger watermark AND larger-or-equal tokens → UPDATE applies (legitimate growth still wins).
- Equal-watermark re-parse → no update (idempotent, unchanged behavior).
- The rejection metric increments on the shrink case.

## Acceptance criteria (100% = all true)
- [ ] Pre-flight watermark assumption re-confirmed (note the result in the PR).
- [ ] A smaller-window, higher-watermark re-emit no longer overwrites token OR content columns.
- [ ] Legitimate larger re-parses and equal-watermark idempotency are unaffected.
- [ ] A metric exposes rejected shrink-writes.
- [ ] Tests above green.

## Merge checklist
- [ ] proxai_nest PR merged

## Orchestrator quick-check (run on "Phase 4 done")
- `grep -n "input_tokens + \|COALESCE\|WHERE" proxai_nest/src/agent-gateway/parse/services/parse-batch-upsert.service.ts`
  → confirm the shrink-guard clause is in the ON CONFLICT WHERE.
- Confirm the rejection metric is registered (see metric-kind-registry rule) and a test asserts the reject path.

## Data-refresh implication
Forward-protective (prevents future corruption). Historical rows already overwritten cannot be un-overwritten by
this guard alone; Phase 11 re-parse recomputes them correctly.
