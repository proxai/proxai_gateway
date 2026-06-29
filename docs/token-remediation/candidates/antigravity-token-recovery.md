# Candidate — Antigravity (Gemini) token coverage

- **Status:** 🟢 LARGELY A NON-ISSUE — Gemini token telemetry is **~98% present** in prod (the CLI/SQLite path is alive). Only the small **antigravity-IDE (jsonl) path** is token-null. Plus a real **F3 phantom** lingering in the CLI path (see below).
- **Severity:** 🟢 low (was wrongly 🟠 "zero telemetry" in two earlier revisions)
- **Effort:** the IDE gap is tiny + low-value; the F3 phantom fix is the only worthwhile item.
- **Repos:** proxai_nest (parser) + proxai_gateway (capture)
- **History:** surfaced 2026-06-26 (F3 check); rewritten 2026-06-29 twice. **The first two revisions were WRONG** (claimed "zero telemetry / decode the encrypted .pb / SQLite is gone"). This revision is grounded in **prod DB + prod S3 capture bodies** (read-only, 2026-06-29).

## Prod-verified reality (DB + S3 capture bodies, 2026-06-29)
There are TWO Gemini capture paths, and the earlier analyses mistook the local machine (IDE-only) for the whole picture:

| platform | capture body | parser | tokens? | prod rows |
|---|---|---|---|---|
| **antigravity-cli** | `sqlite_rows_json` (plaintext `input_tokens`/`output_tokens`/`cache_read`/`cache_creation` per step) | gemini/v1 (1.0.0) | ✅ **YES** | 1,492 / 1,522 (~98%) — ALIVE (captures dated 2026-06-24) |
| **antigravity-ide** | `transcript.jsonl` (`step_index/source/type/status/created_at/content` — no usage) | gemini/v2 (2.0.0) | ❌ null | 9 / 1,522 (~0.6%) |

A real prod CLI row body: `{"idx":…,"model":"1132","input_tokens":134151,"output_tokens":406,"cache_read_input_tokens":null,"cache_creation_input_tokens":113}`. The tokens are **plaintext in the captured body and already extracted** — no `.pb`, no decode, no recovery needed.

## Corrections to the two earlier revisions
1. **"Gemini ships zero token telemetry" — FALSE.** ~98% of gemini ACRs carry tokens (the CLI/SQLite path). Only the small IDE/jsonl path is null.
2. **"Tokens live in the encrypted conversation `.pb`; recovery is XL/infeasible" — RED HERRING.** That was the local machine (IDE-only, no `.db`). The CLI tokens are plaintext in `sqlite_rows_json` capture bodies, already parsed. The encrypted `.pb` is irrelevant to the real path.
3. **"Antigravity dropped the SQLite format" — FALSE in prod.** antigravity-cli still emits `sqlite_rows_json` captures (verified 2026-06-24). It's gone only on the *local* (IDE) machine.

## The two genuine residuals
1. **F3 phantom `cache_creation` — STILL LIVE (mis-marked resolved).** 1,492 CLI ACRs carry a positive `cache_creation_input_tokens` (sum ~8.18M, max ~138k) — Gemini has no cache-write, so this is the F3 phantom. The #9 refactor only nulled the empty IDE path. **Not a live double-count** (no aggregate folds `cacheCreation` into a total — see ROADMAP pre-flight), but wrong data. Fix = null `cache_creation` for gemini in the v1 parser + Phase 11 backfill. See `../phase-03-gemini-phantom-cache-creation.md` (re-opened).
2. **IDE/jsonl token gap — small + low-value.** 9 rows (~0.6%). The IDE `transcript.jsonl` genuinely has no usage (verified). Whether the IDE writes a tokens-bearing `.db` like the CLI (capturable) was not determined; given the size, not worth chasing now. A shadow-probe PR for this (#234) was **closed** — it watched a speculative path (`usageMetadata` in the jsonl) for a 0.6% gap, on a now-false "all gemini null" premise.

## Recommendation
- **Drop the "token recovery" framing** — there is little to recover; Gemini is ~98% covered.
- **Do fix F3** (the phantom) for the CLI path — small parser change + backfill — and correct the F3 "resolved" status.
- **Leave the IDE/jsonl gap** as a known 0.6% limitation.
