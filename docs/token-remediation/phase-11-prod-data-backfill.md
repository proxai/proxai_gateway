# Phase 11 — Production data backfill / re-parse

- **Status:** ⬜ NOT STARTED
- **Severity:** 🟠 medium (operator-run) · **Effort:** M
- **Repos:** proxai_nest (re-parse trigger / script) — executed against prod by the OPERATOR
- **Depends on:** Phases 2, 3, 5, 7 merged (the backfillable fixes) — also benefits from 4, 6 · **Blocks:** —
- **Source:** ROADMAP.md "Backfillability" table · IMPLEMENTATION_PLAN.md Rank 11

## Concern this phase eliminates
Historical prod ACRs were computed with the old (buggy) parser logic. For the BACKFILLABLE findings, re-parsing
the existing S3 captures through the fixed pipeline corrects the stored ACRs (the deterministic-id UPSERT
REPLACEs each row — no double-count). This phase refreshes historical token data so dashboards reflect the
corrected logic.

## ⚠️ Scope + the one permanent gap
| Finding | Re-parse corrects it? |
|---|---|
| F2 Codex over-count (Phase 2) | ✅ yes |
| F3 Gemini cacheCreation (Phase 3) | ✅ yes (nulls the phantom) |
| F4/orphan-drop CC (Phase 5) | ✅ yes (continuation records are in S3) |
| Codex re-attach (Phase 6) | ✅ yes |
| Claude Desktop (Phase 7) | ✅ yes (now-parseable; populated for the first time) |
| **F1 Claude Code dialogue-filter drop (Phase 1)** | ❌ **NO — permanent gap.** The dropped records never reached S3, so no re-parse can recover historical CC under-counts. Only captures taken AFTER Phase 1 merged are correct. |

State the F1 permanent gap to stakeholders before running the backfill so corrected vs. uncorrectable history is
understood.

## Background (read first)
- Re-parse mechanism: nest already has an operator-driven reparse path (search `reparse` /
  `reparse-chats` in `proxai_nest/src/agent-gateway/parse/`). Re-running it over a capture range re-derives ACRs
  via the same pipeline; the gated UPSERT (`parse-batch-upsert.service.ts`) REPLACEs each row idempotently.
- Equal-watermark re-parse is idempotent (verified); the Phase-4 shrink-guard protects against any smaller-window
  re-emit during the backfill.

## Scope: ALL history (2026-06-17 decision)
Re-parse the **entire** S3 capture history for the affected agents — not a bounded window. Because this is the
full corpus, batching + a dry-run are mandatory to size the operation and avoid a connection/throughput storm.

## Change spec
### proxai_nest (implementer builds; OPERATOR runs against prod)
- Provide a scoped re-parse invocation/script that re-processes ALL existing captures for the affected agents
  (gemini, CODEX, CLAUDE_CODE, CLAUDE_DESKTOP), in batches, read-from-S3 → re-derive → UPSERT. Dry-run mode first
  (report counts of rows that would change, and the total capture volume) before the live run. Throttle batch
  size + concurrency so the backfill doesn't exhaust the PgBouncer/PM2 connection budget (see deployment
  pool-sizing knowledge).
- Do NOT write raw DML; go through the parser/upsert pipeline (per repo rules, agents never run prod DML — the
  operator executes the provided script).

## Acceptance criteria (100% = all true)
- [ ] Phases 2, 3, 5 (and 6, 7 if landed) are ✅ before running.
- [ ] Dry-run produces a sane change-count report per agent.
- [ ] Live re-parse run completed by the operator; spot-checked ACRs show corrected tokens (Codex lower, Gemini
      cacheCreation null, Desktop populated, CC idle turns recovered).
- [ ] F1 permanent-gap caveat communicated.

## Merge / run checklist
- [ ] re-parse script/trigger merged (proxai_nest)
- [ ] dry-run reviewed
- [ ] **operator** runs the live backfill against prod (NOT the agent)

## Orchestrator quick-check (run on "Phase 11 done")
- Confirm the prerequisite phases are ✅.
- Confirm a dry-run report exists and the operator confirms the live run finished.
- Spot-check: a known multi-turn Codex conversation's stored input dropped; a Gemini row's cacheCreation is null;
  a Claude Desktop conversation now has ACRs.

## Data-refresh implication
This IS the data refresh. Forward correctness is handled by Phases 1-8; this phase fixes the past where possible.
