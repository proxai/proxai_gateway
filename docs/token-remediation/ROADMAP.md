# Token Remediation — Implementation Roadmap (orchestrator surface)

**Owner of this doc:** the "orchestrator" Claude chat (tracking only — never implements).
**Created:** 2026-06-17 · **Basis:** `../planning/token-issues/VERIFICATION_FINDINGS.md` + `../planning/token-issues/IMPLEMENTATION_PLAN.md` (both verified across 2 adversarial rounds).

This folder is the **execution tracker** for the token-counting fixes, plus a preserved copy of the analysis.

## Folder contents & provenance
- `ROADMAP.md` + `phase-NN-*.md` — the execution plan (what to build, in what order, is it done).
- `analysis/` — the full detection/verification record, **copied here from the gitignored `docs/planning/token-issues/`**
  (that folder is `.gitignore`d at `.gitignore:38`, so it is NOT tracked and would be lost on a local wipe).
  Includes `VERIFICATION_FINDINGS.md`, `IMPLEMENTATION_PLAN.md`, `CURSOR_TOKEN_COLLECTION.md`, the original
  small-model `*_analysis.md` inputs, and their scripts. **This tracked copy is the durable source of truth** —
  if `analysis/` and `docs/planning/token-issues/` ever drift, this one is canonical.
- `verification-scripts/` — every token-analysis script (moved out of `proxai_nest/scripts/Gemini stats/` so Nest
  stays clean). The rigorous reproducible proofs are `verify_token_semantics.ts` (Gemini input = non-cached, the
  148-row proof), `confirm_gemini_proto_semantics.ts` (per-request dedup non-issue), `confirm_gemini_total_field.ts`
  (the F3 `5.9.3 == 5.9.9 + 5.9.10` identity + ratio/cache-hit backstops), and `verify_residual_risks.ts`. The
  rest are exploratory/small-model originals kept for provenance. NOTE: they read LOCAL data (paths like
  `~/.gemini/antigravity-cli/conversations/*.db` and `POSTGRES_URL_READ_ONLY_PROD`); they are reference, not
  part of the build. **Stored as `*.ts.txt`** (frozen reference — the gateway lints + source-restricts real
  `.ts`; rename back to `.ts` to run). This also keeps the small model's `analysis/scripts/recalculate_db_tokens.ts.txt`
  (a prod-WRITE script flagged DO-NOT-RUN in `analysis/VERIFICATION_FINDINGS.md`) non-runnable as committed.

---

## How this works (the process)

1. Each numbered phase below has its own self-contained doc (`phase-NN-*.md`). It is the ONLY doc the
   implementer + verifier pair needs for that phase.
2. For each phase, the operator opens two chats: a **small-model implementer** and an **Opus 4.8 verifier**.
   They implement the change across the listed repos, the verifier confirms the **Acceptance criteria** are
   100% met, then both PRs (gateway + nest, and web where listed) are merged.
3. The operator returns to the **orchestrator chat** and says "Phase N done." The orchestrator runs the
   phase's **Orchestrator quick-check**, confirms, flips the status here to ✅ DONE, and points to the next phase.
4. Phases are **isolated**: when a phase is merged on all its listed repos, the concern it names is eliminated.
   Do phases in order unless the orchestrator says a later one is unblocked to run in parallel.

**Status legend:** ⬜ NOT STARTED · 🔵 IN PROGRESS · 🟣 AWAITING ORCHESTRATOR CHECK · ✅ DONE · ⏸️ DEFERRED

---

## Status board (the orchestrator maintains this)

| # | Phase | Sev | Repos | Depends on | Status |
|---|---|---|---|---|---|
| 1 | Claude Code usage preservation (F1) | 🔴 | gateway + nest | — | ✅ merged (gw #10, nest #228) |
| 2 | Codex over-count fix (F2) | 🔴 | nest | — | ✅ done (branch pushed; PR pending) |
| 3 | Gemini phantom cache_creation (F3) | 🔴 | gateway (+nest opt) | — | ✅ resolved by #9 refactor — see phase-03 |
| 4 | Upsert shrink-guard (overwrite corruption) | 🔴 | nest | — | ✅ done (feat/token-remediation-f2-f4) |
| 5 | Claude Code idle-flush orphan-drop | 🔴 | nest | 4 | 🟡 Stage A done · Stage B deferred (see phase-05) |
| 6 | Codex re-attach parser guard | 🟠 | nest | 4 | ✅ done (nest PR #231 open @2ce3845c; main protected) |
| 7 | Claude Desktop version resolution | 🟢 | nest + gateway | — | ⚠️ RE-SCOPED — premise INVALID; Desktop already counted under CLAUDE_CODE (see phase-07) |
| 8 | Cursor local-only collection | 🟠 | nest + gateway | — | ⏸️ DEFERRED |
| 9 | deterministicRecordId fallback hardening | 🟢 | nest | — | ⬜ |
| 10 | Web KPI label + Cursor null display | 🟢 | web | 3 | ⬜ |
| 11 | Production data backfill / re-parse (ALL history) | 🟠 | ops script | 2, 3, 5, 7 | ⬜ |

**Active phases:** 1, 2, 3, 4, 5, 6, 9, 10, 11 (9 phases). **Phase 7 (Desktop) is RE-SCOPED** — its original
premise is invalid (Desktop tokens are already counted under `CLAUDE_CODE`/`claude-code-desktop`; "fixing" version
resolution would double-count), so only optional cleanup remains; see phase-07 + the 2026-06-29 note below.
**Phase 8 (Cursor) is DEFERRED** — Cursor stays
all-null for now; revisit as a separate feature later (its doc is parked, not deleted).

Phases 1–7 are the **detections** (token-correctness). 8 is a **feature-add**. 9–10 are **hardening/display**.
11 is the **historical-data refresh** that runs after the critical code phases land.

> **Status update (2026-06-26).** Phases **1 (F1)** and **2 (F2)** are complete — F1 merged (gw #10 + nest #228);
> F2 on `feat/codex-over-count-f2`, pushed + end-to-end validated against real rollouts (PR pending). Phase
> **3 (F3)** is **resolved by the Antigravity capture refactor (gw #9)**: the phantom proto-decode was deleted,
> so Gemini `cacheCreationInputTokens` is null (see `phase-03-*.md`). A **new gap** surfaced during that check —
> Antigravity now ships **zero token telemetry** (the captured `transcript.jsonl` has no token counts; the real
> tokens live in the conversation `.pb` proto). Recovery is feature-sized and tracked in
> `candidates/antigravity-token-recovery.md` (not scheduled). **Next active phase: 4 (upsert shrink-guard).**

> **Status update (2026-06-29).** Phases **4 (F4)**, **5 (F5 Stage A)** and **6 (F6)** are complete on nest.
> Nest `main` = F1+F2+F4 (merged via nest #230); **F6** (`2ce3845c`) is up as **nest PR #231** (main is a protected
> branch — 2 required checks — so F6 lands via PR, not a direct push). Gateway docs pushed to gateway `main`.
> F6 (Codex re-attach guard) extends the duplicate-`task_started` guard to also drop a re-attach of
> the most-recent emitted turn (`lastEmittedTurnId`), counted via `agent_gateway_parser_codex_reattach_dropped_total`;
> the in-open-turn dedup and a different open turn are left untouched, and F4 stays the upsert backstop. Adversarial
> plan-review + post-impl code-review both passed (ready-to-merge); full nest unit suite 8654/8654 green.
> **Next active phase: 7 (Claude Desktop version resolution)** — depends on 1, 4, 5 (all satisfied).

> **Status update (2026-06-29) — Phase 7 RE-SCOPED (premise INVALID).** Read-only prod check: Claude Desktop
> conversation tokens are ALREADY counted under `CLAUDE_CODE` as `source_platform=claude-code-desktop` (811 ACRs);
> there is NO `CLAUDE_DESKTOP` agent (0 ACRs / 0 parse states). The `claude-desktop`/`claude-cowork-desktop`
> `audit.jsonl` stream (468 captures, 6 hosts) is ~97% redundant with those transcripts (456/468 carry a real CLI
> version = the audit record matched a `.claude/projects` transcript), so the original "fix version resolution"
> would DOUBLE-COUNT (ACR id includes `agent`). Phase 7 downgraded to 🟢 cleanup-only; Phase 11 needs no Desktop
> backfill. **Next active phase: 9 (deterministicRecordId hardening) or 10 (web display).** See phase-07 for the
> full re-scope + evidence.

---

## Pre-flight findings (resolved by the orchestrator; baked into the phase specs)

- **Single shared parse watermark.** `agent_parse_states.last_processed_watermark` is advanced by ONE gated
  UPSERT (`proxai_nest/src/agent-gateway/parse/services/parse-process-chat.service.ts:355-399`), and the
  idle-flush processor routes through the same `parse-process-chat` path → **idle-flush advances the same
  watermark the main parser reads.** Implication: the F4 *same-ACR overwrite for Claude Code* is very unlikely
  to fire (the pre-flush USER record is never re-read); the **silent orphan-drop (Phase 5) is the dominant CC
  idle-flush loss.** The upsert shrink-guard (Phase 4) remains warranted for the **Codex `task_started`
  re-attach** case (it arrives in NEW post-flush captures) and as defense-in-depth. Phases 4/5 each re-confirm
  in-phase.
- **Gemini `cacheCreationInputTokens` has no analytics reader.** It is only written
  (`build-scalar-spine.ts:162`, `parse-batch-upsert.service.ts:466`); no aggregate folds it into a total. So
  Phase 3 (zeroing it for Gemini) is safe with no downstream double-count to chase.

---

## Backfillability of historical data (drives Phase 11)

| Finding | Historical prod data | Recoverable by re-parse? |
|---|---|---|
| F1 (CC dialogue-filter drop) | dropped at the gateway BEFORE S3 upload | ❌ **NO** — the bytes never reached S3; only future captures are fixed |
| F2 (Codex over-count) | full `token_count` events ARE in S3 | ✅ yes — re-parse recomputes correctly |
| F3 (Gemini cacheCreation) | composer/step data in S3 | ✅ yes — re-parse (or a targeted null) |
| F4 orphan-drop (CC idle) | continuation records ARE in S3 (drop is in nest, post-upload) | ✅ yes — re-parse |
| Codex re-attach | in S3 | ✅ yes — re-parse |
| Claude Desktop | conversations ALREADY captured under CLAUDE_CODE/claude-code-desktop | n/a — NOT a separate backfill (the audit.jsonl/cowork stream is ~97% redundant; re-parsing under CLAUDE_DESKTOP would double-count) |

Phase 11 re-parses existing S3 captures through the fixed pipeline (upsert REPLACE semantics correct the ACRs).
**The one permanent gap is F1's historical Claude Code under-count** — that data is gone; set expectations.

---

## Token semantics — SETTLED (no decision needed; do not re-open)

The analysis already decided the canonical, billing-accurate semantics, uniform across all agents:
**a turn's stored tokens = the SUM of the independently-billed `usage` of every distinct model API call in that
turn** (input / output / cache_read / cache_creation each summed). This is what the provider bills. There is NO
"final context size" alternative in use. Per-agent, this is recovered as:
- **Claude Code:** SUM per-call `usage` (Anthropic bills per request, not cumulative). Phase 1 just makes the
  existing sum COMPLETE by stopping the gateway from dropping tool_use calls.
- **Codex:** SUM of distinct calls via the cumulative-total diff `total_token_usage(end) − total_token_usage(start)`
  (Phase 2), which excludes re-emitted/rate-limit frames. (`output_tokens` already includes reasoning.)
- **Gemini:** SUM per step (already correct — distinct calls, no re-emit). Phase 3 only nulls the phantom
  `cacheCreation`; input/output/cacheRead are untouched.

### Column normalization — `inputTokens` = FRESH INPUT; raw cache-write KEPT (decided 2026-06-17)

`inputTokens` carries the comparable "fresh input" for every agent, AND the authentic Anthropic cache-write count
is preserved in its own column (no data lost). The overlap is handled by SUBTRACTION (operator decision), not by
nulling the column.

| Column | Definition | Claude Code | Gemini | Codex |
|---|---|---|---|---|
| `inputTokens` | **fresh input** = full-rate tokens NOT served from cache (INCLUDES any written to cache) | `input_tokens + cache_creation_input_tokens` | `5.9.2` | `input_tokens − cached_input_tokens` |
| `cacheReadInputTokens` | cache reads (discounted; **DISJOINT** from inputTokens) | `cache_read_input_tokens` | `5.9.5` | `cached_input_tokens` |
| `cacheCreationInputTokens` | raw cache-WRITE tokens — **kept for provenance; a SUBSET of `inputTokens`, NON-additive**; null where the provider reports none | `cache_creation_input_tokens` (kept) | null (phantom removed in P3) | null (OpenAI reports none) |
| `outputTokens` | output incl. reasoning | `output_tokens` | `5.9.3` | `output_tokens` |

**Calculation rules — the `cacheCreation` overlap is handled by subtraction, NOT addition:**
- raw non-cached input (the API's bare `input_tokens` tail) = `inputTokens − cacheCreationInputTokens`.
- total input = `inputTokens + cacheReadInputTokens`. **NEVER add `cacheCreationInputTokens` to a total** — it is
  already inside `inputTokens` (adding it is the F3 double-count shape).
- grand total = `inputTokens + cacheReadInputTokens + outputTokens`.
- **Invariant (add a test):** `0 ≤ cacheCreationInputTokens ≤ inputTokens` for Claude; `cacheCreationInputTokens
  = null` for Gemini/Codex.

**Why this shape:** `inputTokens` is uniform "fresh input" → directly comparable, never abnormally low (Claude
370M ≈ Gemini 354M; median 21 → ~18.4k). The authentic cache-write count is preserved for future reference /
$-cost (writes bill ~1.25× at Anthropic; no $ computed today). Compatibility: the existing web "Token Usage" KPI
is `input+output+cacheRead` — it already EXCLUDES `cacheCreation`, so it is correct as-is under this scheme; the
downstream per-column `COALESCE(SUM)`s are display-only. The discipline cost: `cacheCreation` is a non-additive
subset — any NEW grand-total must follow the rules above (see `analysis/CROSS-SOURCE-NORMALIZATION.md`).

## Decisions LOCKED (2026-06-17 — do not re-open)

1. **Reasoning-token field (Phase 3b): SKIP.** Phase 3 ships the null-the-phantom fix only; `outputTokens` stays
   the combined (visible+thoughts) total, which is correct. No new schema column. Gemini `5.9.9` and Codex
   `reasoning_output_tokens` remain dropped. (Revisit only as a future standalone feature if ever wanted.)
2. **Backfill scope (Phase 11): ALL history.** Re-parse every S3 capture for the affected agents
   (gemini, CODEX, CLAUDE_CODE, CLAUDE_DESKTOP). Dry-run + batched. Note the permanent gap: F1 Claude Code
   dialogue-filter history is NOT recoverable (dropped pre-upload).
3. **Cursor (Phase 8): DEFERRED.** Not in the active set. Cursor stays all-null; the only Cursor-related work
   that remains active is the honest "not captured" display in Phase 10. Revisit collection later.
4. **Branch strategy: STACKED INTEGRATION BRANCH.** One long-lived integration branch off `main`; each phase
   builds on the prior, in roadmap order. Phase 7 (Desktop) naturally sits on top of Phases 1/4/5. The whole
   integration branch merges to prod once all active phases are complete + verified.

## Merge model (per operator, 2026-06-17)

Nothing merges to **prod** until all 11 phases are complete — so the prod-exposure risk behind the Phase 7
sequencing gate is moot (Desktop can't expose under-counting in prod before the F1/F4/F5 fixes are also live).
The only residual is **code build-order**: Phase 7's branch must be built on top of Phase 1/4/5's code to be
correct and testable (Desktop reuses the Claude Code parser), and Phase 11 (backfill) runs against prod only
after the big merge. The orchestrator tracks build-order, not prod-safety gating.
