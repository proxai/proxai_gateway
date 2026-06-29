# Candidate — Antigravity (Gemini) token recovery

- **Status:** 🔬 CANDIDATE — **recovery from local artifacts is INFEASIBLE** (the conversation `.pb` is encrypted). Effectively an accepted gap until Antigravity changes its own logging.
- **Severity:** 🟠 — Gemini/Antigravity ships **zero token telemetry** going forward (v2 jsonl path; all usage null). Confirmed.
- **Effort:** XL / research-grade (break encryption) or infeasible from disk. The only *cheap* path (≈S) is contingent on Antigravity emitting usage in the jsonl — outside our control.
- **Repos:** proxai_gateway (capture) + proxai_nest (parser)
- **Surfaced:** 2026-06-26 (Phase 3 / F3 check). **Re-investigated empirically 2026-06-29 — this doc was rewritten; the original premise was wrong (see "Corrections" below).**

## The gap (confirmed at code + prod level, 2026-06-29)
The current gemini parser is **v2** (`parser_version 2.0.0`, the post-#9 jsonl path). It has **no usage extractor at all** — `proxai_nest/src/agent-gateway/parsers/gemini/extractors/index.ts` registers none, and the gemini/v2 parser set deliberately omits `result.usage.*` from `declaredFields` (`parsers.versions.ts:840-855`). So `gemini-finalize-turn.service.ts` reads `result.usage.*` → all `null`. **Parser-wide, not platform-specific.**

Prod (read-only, 2026-06-29): the cli-vs-ide split is really **v1-vs-v2 = SQLite-vs-jsonl**. 1,492 `antigravity-cli @ 1.0.0` rows carry full tokens (from the OLD SQLite path); the `antigravity-ide @ 2.0.0` rows are all-null jsonl. (Aside: those 1,492 old rows still carry the **F3 phantom cacheCreation** — F3 was only "resolved" for v2, which has null everything.)

## Why recovery is infeasible from disk (the decisive findings)
Verified on 3 real conversations under `~/.gemini/antigravity/` (`e923871b`, `a27bb4d5`, `f3486f10`):

1. **The conversation `<uuid>.pb` is ENCRYPTED.** Shannon entropy **7.999 bits/byte**, all 256 byte values present, no readable strings, does not parse as protobuf. (Control: `agyhub_summaries_proto.pb` — the index the gateway *does* read for folder identity — is plaintext at entropy 6.24 with readable UUIDs/paths. So some Antigravity protos are cleartext; the conversation bodies are not.) `implicit/*.pb` are also encrypted (entropy 8.00).
2. **No plaintext token telemetry exists anywhere on disk.** Grepping the entire `~/.gemini/antigravity/` tree for `usageMetadata` / `tokenCount` / `promptToken` / `candidatesToken` / `cachedContent` / `totalToken` returns **zero hits** — not in the jsonl, not in any `.pbtxt`, nowhere.
3. **The captured `transcript.jsonl` has no usage** — only `step_index / source / type / status / created_at / content / thinking`. (A raw `grep usage` yields 3 hits — the literal word "usage" inside conversation prose, not a field.)

## Corrections to the original (2026-06-26) version of this doc
The original premise — *"the per-call usage still lives in the conversation `.pb`; decode it like the old `step-decode.ts`"* — is **wrong on the decisive points**:
1. **"Tokens live in a decodable conversation `.pb`" — FALSE.** The `.pb` is encrypted (entropy 7.999, verified). There is no decodable usage source.
2. **"The old `step-decode.ts` read the `.pb`" — FALSE.** It read **SQLite `*.db`** step-table payloads (`bun:sqlite`, glob `*.db`). **Antigravity has since dropped the SQLite format** (no `.db` files exist locally) — so the old token source is gone *independent of #9*.
3. **"The proto↔jsonl join is the crux" — MOOT.** There's no decodable left-hand side to join from. (Secondary: the jsonl `step_index` has gaps — e.g. `0,1,2,4,5` — so even hypothetically the join would need fallback logic.)
4. **Effort "M–L" — UNDERSTATED.** It is XL/research-grade (break encryption) or infeasible from disk.
5. The deleted proto field paths (`5.9.2` input, `5.9.3` output, `5.9.5` cacheRead, `5.9.10` phantom, `5.9.11` requestId, `5.20.2` idx) were correct — but they applied to the **SQLite row payloads**, a format that no longer exists. The old decoder also folded `cacheRead` INTO input (`inputTokens = 5.9.2 + 5.9.5`).

The #9 refactor (commit `f0d4f53`, "Feat/antigravity capture") deleted `step-decode.ts` / `proto-scan.ts` / `process-rows.ts` / `resolve-identity.ts` and switched to the byte-range-streamable, folder-linkable jsonl. **That trade-off was sound and need not be reverted** — re-adding a proto path would decode nothing (encrypted), regressing folder-linkability for zero token gain.

## Options
| Option | What | Effort | Verdict |
|---|---|---|---|
| A | Reverse-engineer the `.pb` encryption | XL / research-grade | No — real cipher (entropy 8.0); key not in adjacent files; brittle to version bumps |
| B | Capture tokens at the network layer (proxy Gemini `usageMetadata`) | L–XL | No — the gateway is a local-file capturer, not a network proxy |
| C | Wait for Antigravity to log usage in the jsonl, then add **one** extractor | S | Natural path — v2 already slots `result.usage.*` in `finalizeTurn`, just unfed — but contingent on Antigravity |
| D | Accept Gemini as token-less; document the limitation | 0 | The honest current state |

## Recommendation
**Defer / accept the gap.** Recovery from local artifacts is infeasible (encrypted `.pb`, SQLite format gone, no usage in jsonl). Keep the #9 jsonl trade-off. The only cheap path (C) is outside our control.

**Cheap insurance (implemented):** a **shadow-probe** — the gemini parse path emits `agent_gateway_parser_gemini_usage_field_seen_total` if a captured `transcript.jsonl` ever contains `usageMetadata`/`tokenCount`. When that metric ever fires, Antigravity has started logging usage and option C (≈1 day: add a `usage` extractor + register it + add `result.usage.*` to v2 `declaredFields` + bump parser_version) is unblocked. No architectural change, no commitment.

## If pursued via option C — acceptance sketch
- Add a `usage` extractor under `gemini/extractors/`, register in `index.ts`, add `result.usage.*` to the gemini/v2 `declaredFields`, bump `GEMINI_PARSER_VERSION`.
- Gemini ACRs carry real `input` / `output` / `cacheRead` (cacheCreation stays null — Gemini has none).
- No regression to the jsonl turn-segmentation / folder-linkability.
