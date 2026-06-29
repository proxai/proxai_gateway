# Phase 3 — Gemini phantom cache_creation (F3)

- **Status:** ⚠️ **RE-OPENED (2026-06-29) — NOT resolved.** "The phantom no longer exists" is false: **1,492 prod gemini ACRs carry a positive `cache_creation` (sum ~8.18M)** — verified against prod DB + S3 capture bodies. #9 only removed the proto path + the empty IDE/jsonl path; the phantom lives in the CLI `sqlite_rows_json` path. At minimum a Phase 11 backfill is needed (whether new CLI captures still emit it needs a gateway-code check). Old "Resolution" below was wrong. (Mitigating: no aggregate folds `cacheCreation` into a total → wrong-data, not a live double-count.)
- **Severity:** 🔴 high (latent) · **Effort:** S
- **Repos:** proxai_gateway (+ proxai_nest only if adding the optional reasoning field)
- **Depends on:** none · **Blocks:** Phase 10 (KPI label), Phase 11 (backfill)
- **Source:** VERIFICATION_FINDINGS.md §10.1, §11.1 · IMPLEMENTATION_PLAN.md Rank 3

## ⚠️ RE-OPENED (2026-06-29) — the "Resolution" below was WRONG

Verified against **prod DB + prod S3 capture bodies** (read-only): the phantom is **live data**, not gone.

- **1,492 / 1,522 gemini ACRs carry a positive `cache_creation`** (sum ~8,175,160; max ~138,246) — all `antigravity-cli`, parser_version 1.0.0. Gemini has no cache-write → phantom. Samples: output 1776 / cacheCreation 758; output 27693 / cacheCreation 13802 (cacheCreation < output, consistent with `5.9.10`=`candidatesTokenCount`, a slice of output — exactly this phantom).
- **The source is NOT the deleted proto `step-decode.ts`.** Gemini has two capture paths: **antigravity-cli → `sqlite_rows_json`** (the captured body carries a plaintext `cache_creation_input_tokens`, e.g. `113`, which gemini/v1 extracts) and **antigravity-ide → `transcript.jsonl`** (no usage → null). #9 deleted the proto path and the IDE/jsonl emits null, so the phantom is gone ONLY for the ~0.6% IDE path. The dominant CLI path was never addressed.
- **Impact:** wrong data, NOT a live double-count (no aggregate folds `cacheCreation` into a total — pre-flight).
- **Fix (effort S):** (1) confirm whether the *current* gateway gemini SQLite capture still emits `cache_creation_input_tokens` (quick code check — historical-only vs ongoing); (2) null it at the source (gateway capture or nest gemini/v1 extractor); (3) Phase 11 backfill to clear the 1,492 rows. See `candidates/antigravity-token-recovery.md` — Gemini is ~98% token-covered (the CLI path also carries the real input/output/cacheRead), contrary to the earlier "zero telemetry" claims.

---

## ~~✅ Resolution (2026-06-26)~~ — SUPERSEDED / INCORRECT (kept for history): superseded by the Antigravity refactor

The proto decode this phase targets — `gateway/src/sources/gemini/step-decode.ts` and its `5.9.10 → cacheCreationInputTokens` mapping — was **deleted** in gateway #9 ("Feat/antigravity capture") plus the nest jsonl-parser rewrite. Verified 2026-06-26: no `5.9.10` / `cacheCreation` mapping remains in either repo.

- **F3's goal is met incidentally:** Gemini `cacheCreationInputTokens` is now `null` — the phantom mapping no longer exists. ✅
- **The migration changed Gemini wholesale, though:** capture switched from the token-bearing conversation `.pb` proto to `brain/<uuid>/.system_generated/logs/transcript.jsonl`, which carries **no per-turn token counts**. So Gemini `input` / `output` / `cacheRead` / `cacheCreation` are now **all null** — not just the phantom. This is intentional (the jsonl was chosen for streamable byte-range capture + folder-linkability), not a regression to fix in this phase.
- **The real token data still exists** in the conversation `.pb` (fields `5.9.2` input / `5.9.3` output / `5.9.5` cacheRead). Recovering it is a separate, feature-sized effort — tracked in [`candidates/antigravity-token-recovery.md`](candidates/antigravity-token-recovery.md).

**Outcome:** no code change for this phase; the phantom is gone. The new "Gemini ships zero token telemetry" state is the open item (see the candidate doc). The original phase spec is preserved below for historical context.

---

## Concern this phase eliminates
Gemini's `cacheCreationInputTokens` column is a **phantom** — the gateway maps proto `5.9.10` into it, but
`5.9.10` is `candidatesTokenCount` (the VISIBLE-output token count), a sub-slice already inside `outputTokens`
(`5.9.3`). PROVEN by the identity `5.9.3 == 5.9.9 + 5.9.10` on 39,996/39,996 steps carrying output, and decisively
by the 1,040 no-thinking steps where `5.9.3 == 5.9.10`. It is **latent today** (no aggregate folds cacheCreation
into a total — see pre-flight), but the column holds wrong data and is a landmine for any future
`input+output+cacheRead+cacheCreation` sum. When merged, Gemini's cacheCreation is null/0 (truthful — Gemini has
no cache-creation concept) and no slice of output is double-represented.

## Background (read first)
- Gateway mapping: `proxai_gateway/src/sources/gemini/step-decode.ts:44`
  (`cacheCreationInputTokens: pNum(tree, '5.9.10')`). `5.9.5` (cache-read, `:43`) and the `5.9.2`+`5.9.5` input
  (`:41`) are CORRECT and must stay.
- `5.9.3` (output, `:42`) is correct — it already includes thoughts; do NOT touch it.
- `5.9.9` (`thoughtsTokenCount`) is currently UNMAPPED/dropped.
- Pre-flight: no analytics reader sums Gemini `cacheCreationInputTokens` (`build-scalar-spine.ts:162` +
  `parse-batch-upsert.service.ts:466` are the only writers) → safe to null.

## Accuracy fix is SETTLED; one OPTIONAL forward feature
The accuracy fix needs no decision: **3a — stop mapping `5.9.10 → cacheCreationInputTokens` (set null/0).** No
schema change. Ship this. The per-step summing and the other three Gemini columns are already correct.
- **3b — DECIDED: SKIP (2026-06-17).** Do NOT add a reasoning-token field. Gemini `5.9.9` stays unmapped/dropped;
  `outputTokens` remains the combined (visible+thoughts) total, which is correct. No prisma schema change in this
  phase. (3b is parked as a possible future standalone feature only.)

## Change spec
### proxai_gateway
- `src/sources/gemini/step-decode.ts:44` — stop populating `cacheCreationInputTokens` from `5.9.10`
  (set `null`). Leave `:41` (input), `:42` (output), `:43` (cacheRead) untouched.

### proxai_nest (only if 3b)
- Add the reasoning field to the parser output + prisma schema + extractor; out of scope for 3a.

## Tests (verifier checks these)
- Gateway: decode a step with `5.9.10 > 0` and assert the emitted `cacheCreationInputTokens` is null (3a).
  Assert `inputTokens`, `outputTokens`, `cacheReadInputTokens` are unchanged.
- Nest (regression): the gemini parser spec still produces correct input (non-cached) / output / cacheRead.

## Acceptance criteria (100% = all true)
- [ ] Gemini captures no longer populate `cacheCreationInputTokens` (null/0). (3a — required)
- [ ] 3b reasoning field: skipped by default (only if the product explicitly wants it).
- [ ] `inputTokens` / `outputTokens` / `cacheReadInputTokens` for Gemini unchanged.
- [ ] Tests above green.

## Merge checklist
- [ ] proxai_gateway PR merged
- [ ] proxai_nest PR merged (only if 3b)

## Orchestrator quick-check (run on "Phase 3 done")
- `grep -n "5.9.10\|cacheCreationInputTokens" proxai_gateway/src/sources/gemini/step-decode.ts` → confirm
  `5.9.10` is no longer mapped to cacheCreation.
- Confirm the gateway test asserts null cacheCreation while output/cacheRead unchanged.

## Data-refresh implication
✅ **Backfillable.** Re-parse (Phase 11) nulls historical Gemini cacheCreation. Alternatively a targeted
`UPDATE ... SET cache_creation_input_tokens = NULL WHERE agent = 'gemini'` is possible but is operator-run DML —
prefer the re-parse path. (Harmless to leave historical as-is since nothing sums it, but cleaner to refresh.)
