# Candidate — Antigravity (Gemini) token recovery from the conversation proto

- **Status:** 🔬 CANDIDATE (not scheduled)
- **Severity:** 🟠 — Gemini/Antigravity ships **zero token telemetry** today (all usage null)
- **Effort:** M–L (feature-sized; the join is the hard part)
- **Repos:** proxai_gateway (capture + decode) + proxai_nest (parser join)
- **Surfaced:** 2026-06-26, during the Phase 3 (F3) check — see [`../phase-03-gemini-phantom-cache-creation.md`](../phase-03-gemini-phantom-cache-creation.md).

## The gap
Since the Antigravity capture refactor (gateway #9 + the nest jsonl-parser rewrite), Gemini/Antigravity ACRs carry **no token data** — `input` / `output` / `cacheRead` / `cacheCreation` are all `null`. The capture switched from the conversation `.pb` proto (which carried tokens) to `brain/<uuid>/.system_generated/logs/transcript.jsonl` (plaintext, byte-range-streamable, folder-linkable — but no token counts). This was a deliberate trade-off for capture-ability + folder identity, with tokens as the cost.

## Where the tokens still are (verified 2026-06-26)
The per-call usage lives in the **conversation `.pb` proto** at `~/.gemini/antigravity*/conversations/<uuid>.pb`, in the same fields the *old* decoder (`gateway/src/sources/gemini/step-decode.ts`, deleted in #9) read:

| Proto path | Field |
|---|---|
| `5.9.2` | input (prompt) tokens |
| `5.9.3` | output tokens |
| `5.9.5` | cached / cache-read tokens |
| `5.9.10` | `candidatesTokenCount` — the F3 **phantom**; do NOT map to cacheCreation |
| `5.9.11` | request id (candidate join key) |
| `5.20.2` | step/turn idx (candidate join key) |

Confirmed by the pre-#9 `step-decode.ts` in git history. The current `transcript.jsonl` has only `step_index / source / type / status / created_at / content / thinking` — no usage field (verified by inspecting a real transcript).

## Why recovery is non-trivial
1. **Re-capture the `.pb`** — the gateway currently byte-range-captures only the transcript.jsonl; a second per-conversation artifact (the `.pb`) would have to be captured + uploaded.
2. **Decode it** — restore the conversation proto-scan (`proto-scan.ts`, removed in #9). The gateway retains *some* proto-decode capability (`agyhub.ts` decodes the summaries `.pb`), so not from scratch.
3. **Join proto-usage → jsonl-turns (the crux)** — the `.pb` is a per-conversation blob with per-model-call usage; the jsonl is per-step. Aligning "which usage belongs to which turn" across two artifacts (the "opaque, no link" problem) is the real work + risk. Candidate join keys: `5.9.11` (requestId), `5.20.2` (idx), or step ordering/timestamps.

## Recommendation
**Defer.** It partially reverts a deliberate simplification, the proto↔jsonl join is the crux, and it ranks below the remaining 🔴 token-remediation phases (4/5). Ship the rest of the roadmap first; revisit if Gemini token telemetry becomes a priority.

## If pursued — acceptance sketch
- Gemini ACRs carry real `input` / `output` / `cacheRead` again (cacheCreation stays null — Gemini has none).
- Per-turn usage joins to the correct turn (validate by reconciling against the proto's per-call totals — same telescoping discipline used to validate F2).
- No regression to the jsonl turn-segmentation / folder-linkability the #9 refactor bought.
