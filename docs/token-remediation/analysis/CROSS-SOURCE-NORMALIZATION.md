# Cross-Source Token Normalization — independent local audit (2026-06-17)

Independent, from-scratch verification of the proposed-plan token math against **local raw data** for all four
sources (Claude Code, Codex, Gemini/Antigravity, Cursor). Own protobuf reader, no gateway imports. Scripts:
`../verification-scripts/four_source_token_audit.ts.txt` (+ `independent_token_audit.ts.txt`,
`gemini_model_probe.ts.txt`). Rename `.ts.txt` → `.ts` to run.

## The load-bearing lesson: `cache_creation` is provider-specific; raw `input_tokens` is NOT cross-comparable

Anthropic splits a prompt into THREE billed buckets: `input_tokens` (the **uncached tail** after the last cache
breakpoint), `cache_creation_input_tokens` (tokens **written** to cache), `cache_read_input_tokens` (tokens
**read** from cache). Gemini and OpenAI use **implicit caching**: they report a cache-READ count but **no
cache-WRITE token field** — the first call's full prompt just sits in normal input.

Consequence: comparing Claude's `input_tokens` (tail only, e.g. median **21**) against Gemini's `5.9.2`
(full first-call prompt, median **90,109**) produces a fake ~20× gap. It is a **categorization artifact**, not a
calculation error. The fix is to compare **provider-normalized** categories:

| Normalized category | Claude Code | Codex | Gemini | Cursor |
|---|---|---|---|---|
| `non_cached` (fresh, not cached) | `input_tokens` | `input_tokens − cached_input_tokens` | proto `5.9.2` | n/a |
| `cache_creation` (written) | `cache_creation_input_tokens` | **0** (none) | **0** (none) | n/a |
| `cache_read` (read) | `cache_read_input_tokens` | `cached_input_tokens` | proto `5.9.5` | n/a |
| `output` (incl. reasoning) | `output_tokens` | `output_tokens` | proto `5.9.3` (=`5.9.9`+`5.9.10`) | n/a |
| `reasoning` (subset of output) | folded-in (no field) | `reasoning_output_tokens` | proto `5.9.9` | n/a |
| **`fresh_input`** = non_cached + cache_creation | — | — | — | — |

`fresh_input` is the apples-to-apples "new prompt work billed at ~full rate."

## Results (local data, normalized)

- **Counts:** Claude 2,167 queries / 43,989 calls; Gemini 1,746 / 55,431; Codex 7 sessions (retention-pruned);
  Cursor 319 convos / 20,263 bubbles.
- **fresh_input totals: Claude 370.0M vs Gemini 354.1M — ≈ equal (1.04×).** The raw "20×" disappears.
- **Claude median fresh_input = 18,424** (the "new-conversation opener writes ~20k to cache" reality) even though
  median `input_tokens` = 21. Both are correct; the 18k lives in `cache_creation`.
- Claude `cache_creation` total = **352.9M** (present + large — Anthropic writes context to cache every turn);
  Gemini/Codex `cache_creation` = **0** (no such field, NOT "no caching" — Gemini `cache_read` = 6.28B).
- Claude `cache_read` 2.86× Gemini and `output` 3.13× Gemini → Claude's bigger *total* is cache-read-driven
  (re-reading a large cached context on every tool-call; billed cheaply at ~0.1×).
- Gemini proto identity `5.9.3 == 5.9.9 + 5.9.10` held **55,426/55,426 (100%)** on the independent decoder → F3
  re-confirmed (cache_creation phantom; output includes thoughts).
- **Cursor:** all billed token categories **0** (`tokenCount={0,0}`) — confirms no local billed tokens (Phase 8);
  models readable, context-size gauge avg ≈ 65,090 (a gauge, not flow).
- Models named: Claude (opus-4-7, opus-4-8, fable-5), Codex (gpt-5.5), Gemini `#1132 = gemini-3.1-pro-preview`
  (per `~/.gemini/settings.json`; minor ids `#1016/#1035/#1050` not named in local data — opaque enums).

## Verdict + plan decision (2026-06-17)
The proposed-plan extraction is **correct** (validated independently). Decision taken: normalize at the
**storage layer**, not just display — `inputTokens` is stored as **fresh input** (= non-cached + cache_creation)
for every agent, and `cacheCreationInputTokens` is stored **null** (Claude's value folded in; Gemini/Codex never
had one). See ROADMAP "Column normalization" + Phase 1 (fold + null) + Phase 10 (compare columns as-is). This
makes `inputTokens` directly comparable across agents (Claude 370M ≈ Gemini 354M), removes Claude's
abnormally-low look (median 21 → ~18.4k), and eliminates the `cacheCreation` double-count surface entirely.
Trade-off accepted: loses the explicit cache-WRITE count (only matters for $-cost precision at Anthropic's ~1.25×
write rate; no $ computed today). If $ is added later, stash raw `{input_tokens, cache_creation_input_tokens}` in
`agent_metadata` — do NOT un-fold the column.
