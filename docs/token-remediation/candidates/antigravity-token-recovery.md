# Candidate — Antigravity (Gemini) token telemetry

- **Status:** 🟡 token telemetry is **degrading to null going forward** by design (the #9 trade-off), while **existing data is ~98% token-covered**. Recovery for the future is hard + low-priority.
- **Severity:** 🟡 low–medium (Gemini is a small share of usage — 1,522 ACRs total; the loss is forward-looking, not historical)
- **Effort:** recovering forward tokens is L (the jsonl has no usage; the `.pb` is encrypted). Doing nothing is fine for now.
- **Repos:** proxai_gateway (capture) + proxai_nest (parser)
- **History:** this doc was corrected **three times on 2026-06-29**. The first two were wrong ("decode the `.pb`"; then "98% covered / cli path permanently alive"). **This version is the complete picture**, grounded in current gateway code + git history of #9 + prod DB + prod S3 capture bodies + prod capture `gatewayVersion`s.

## The mechanism (timeline)
Gemini token capture is mid-migration. The #9 refactor (`f0d4f53`, "Feat/antigravity capture") replaced the token-bearing SQLite path with a tokenless jsonl path, rolling out across the fleet:

| era | gateway version | gemini capture | tokens |
|---|---|---|---|
| pre-#9 | ≤ `2026.6.17-1` | antigravity-cli → `sqlite_rows_json` (plaintext `input_tokens`/`output_tokens`/`cache_read`/`cache_creation`) | ✅ real tokens + the F3 phantom `cache_creation` |
| **#9, rolling out** | `2026.6.24-1` (current code) | `transcript.jsonl` (`step_index/source/type/status/created_at/content`) | ❌ null |

The **current gateway code captures gemini as jsonl only** (`GEMINI_BODY_FORMAT='jsonl'`; the SQLite/proto files `step-decode.ts`/`proto-scan.ts`/`process-rows.ts` were deleted in #9; only a dead `prompt-extract` branch for old sqlite bodies remains). The SQLite/token captures seen in prod **up to 2026-06-24** are from **un-updated hosts still on ≤`2026.6.17-1`** — they trickle off as the fleet updates.

## What's true right now (prod-verified)
- **Existing data: ~98% token-covered.** 1,492 / 1,522 gemini ACRs carry real tokens (the pre-#9 `antigravity-cli` SQLite captures). 9 are token-null (the `antigravity-ide` jsonl path).
- **Going forward: token-null.** Once the fleet is fully on #9 (jsonl), new gemini ACRs have no tokens — both platforms. This was a deliberate trade-off (jsonl is byte-range-streamable + folder-linkable; tokens were the cost).
- **The `.pb` is encrypted** (entropy 7.999, verified) — so the jsonl path has no token source to fall back to. The earlier "decode the `.pb`" idea is dead.

## F3 phantom — see `../phase-03-gemini-phantom-cache-creation.md`
The F3 phantom `cache_creation` rode the same SQLite path. Its **source is already gone** in current code (deleted by #9), so it self-terminates as hosts update. Residual: **1,492 historical rows** carry it (sum ~8.18M). No aggregate folds `cacheCreation` into a total → **optional backfill**, not a correctness emergency.

## Options for the forward token gap
| option | what | effort | verdict |
|---|---|---|---|
| Do nothing | accept gemini → token-null going forward | 0 | reasonable now (small usage, deliberate trade-off) |
| Restore a token source | re-add a SQLite/token capture alongside the jsonl | M–L | reverts part of #9; only if gemini token telemetry becomes a priority |
| Wait + watch | if Antigravity ever writes `usageMetadata` into the jsonl, add a 1-day extractor (v2 already slots `result.usage.*`) | S (contingent) | outside our control |
| Decode `.pb` | — | XL/infeasible | encrypted; ruled out |

## Recommendation
**Defer.** Existing Gemini data is fine; the forward gap is a deliberate, low-stakes trade-off for a small-usage agent. If it ever matters, the realistic path is restoring a token capture (option 2), not decoding the encrypted `.pb`. A shadow-probe PR for the jsonl-watch path (nest #234) was closed as not-worth-it.
