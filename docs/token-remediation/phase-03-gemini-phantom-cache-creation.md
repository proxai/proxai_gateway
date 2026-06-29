# Phase 3 — Gemini phantom cache_creation (F3)

- **Status:** 🟢 **resolved for new captures; historical residual only** (2026-06-29, final). The phantom's source — the pre-#9 `antigravity-cli` SQLite capture — was **deleted in #9**; current gateway code captures gemini as tokenless jsonl, so **no new phantom is produced**. The original 2026-06-26 "resolved" was right that the source is gone but wrongly claimed "the phantom no longer exists" — **1,492 pre-#9 historical rows still carry it** (sum ~8.18M). No aggregate folds `cacheCreation` into a total → **optional backfill**, not a correctness emergency.
- **Severity:** 🟢 low (historical-only, no reader) · **Effort:** S (optional backfill)
- **Repos:** proxai_gateway (+ proxai_nest only if adding the optional reasoning field)
- **Depends on:** none · **Blocks:** Phase 10 (KPI label), Phase 11 (backfill)
- **Source:** VERIFICATION_FINDINGS.md §10.1, §11.1 · IMPLEMENTATION_PLAN.md Rank 3

## ✅ Status (2026-06-29, final) — source deleted by #9; only historical rows remain

Verified against **current gateway code + git history of #9 + prod DB + prod S3 capture bodies + prod capture `gatewayVersion`s**:

- **The phantom's source is gone in current code.** It rode the pre-#9 `antigravity-cli` → `sqlite_rows_json` capture (whose body carried a plaintext `cache_creation_input_tokens`, e.g. `113`, that gemini/v1 extracts). #9 (`f0d4f53`) deleted the SQLite path; current gemini capture is jsonl-only (`GEMINI_BODY_FORMAT='jsonl'`, no usage). So **new captures produce no phantom** (and no gemini tokens at all — see the candidate doc).
- **Historical residual: 1,492 rows** carry a positive `cache_creation` (sum ~8,175,160; max ~138,246) — all pre-#9 `antigravity-cli`, parser_version 1.0.0. Samples: output 1776 / cacheCreation 758; output 27693 / cacheCreation 13802 (cacheCreation < output, consistent with `5.9.10`=`candidatesTokenCount`, a slice of output — exactly this phantom).
- **Self-terminating tail:** un-updated hosts still on pre-#9 gateway (≤`2026.6.17-1`) kept emitting SQLite captures up to 2026-06-24, so a few more phantom rows may appear until the fleet finishes updating to the #9 (jsonl) gateway.
- **Impact:** wrong data, NOT a live double-count — no aggregate folds `cacheCreation` into a total (pre-flight).
- **Residual action (optional):** Phase 11 backfill to clear the 1,492 historical rows. **No source-fix needed** (the source is already deleted). ⚠️ Caveat for the backfill: a naive re-parse of the OLD `sqlite_rows_json` bodies via gemini/v1 would **re-extract** the phantom (the bodies still carry it) — so the backfill must null `cacheCreation` for gemini explicitly (or have the v1 extractor drop it before any re-parse of pre-#9 captures). See `candidates/antigravity-token-recovery.md`.

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
