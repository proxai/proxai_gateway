# Token-Issue Implementation Plan (priority-ranked)

**Status:** plan only — NO code changed · **Date:** 2026-06-17 · **Basis:** `VERIFICATION_FINDINGS.md` (2 adversarial rounds) + `CURSOR_TOKEN_COLLECTION.md`

Ranked highest → lowest by **production blast-radius × confidence**. Severity, effort (S/M/L), blast-radius,
fix-shape, file:line touch-points, and risk per item. Detections (token correctness) rank above feature-adds
(Cursor) and display fixes. Every finding survived adversarial re-verification (round 2, §11 of
`VERIFICATION_FINDINGS.md`); 0 agents failed.

## Verify-before-fix (two unverified pivots — resolve FIRST)
1. **F4 watermark pivot (gates ranks 4 & 5):** grep which service mutates `AgentParseState.last_processed_watermark`
   and whether the **idle-flush queue** advances the *same* watermark the **main** agent-parse processor reads.
   - If idle-flush DOES advance it → F4's overwrite cannot fire; the silent **orphan-drop** (rank 5) is the real bug.
   - If it does NOT → both the overwrite (rank 4) and the orphan-drop (rank 5) can fire on different chats.
2. **F3 consumer check (gates rank 3):** confirm no consumer currently reads `cacheCreationInputTokens` as
   meaningful for Gemini before zeroing the mapping (round 2 confirmed no aggregate sums it, but double-check
   any per-agent view).

---

## Rank 1 — F1: stop dropping usage-bearing `tool_use` records before upload  🔴 CRITICAL · effort L
**Blast radius:** largest — most-used agent (15.5k ACRs); ~75% of cache/output telemetry currently lost. Also
fixes Claude Desktop once its version short-circuit (rank 7) is removed.
**Fix shape:** split display-filtering from telemetry — upload ALL session lines from the gateway (or add an
`isDialogueVisible` flag marking display-only records while still uploading their usage), so nest receives every
per-call usage block and `aggregateUsage` sums the full agentic loop instead of survivors only. **Confirm product
intent** ("total billed across the loop" vs "final/max context") before sizing.
**Files:** gateway `src/sources/claude-code/collect.ts:142-203,251` (isDialogueRecord + upload filter); nest
`src/agent-gateway/parsers/claude-code/claude-code.utils.ts:400-414`;
`.../services/claude-code-finalize-turn.service.ts:99`.
**Risk:** S3 upload-volume increase; downstream must treat summed loop usage as intended. High confidence in the
bug; medium in the exact product semantics of the fix.

## Rank 2 — F2: Codex over-count — replace blind `token_count` summing with cumulative-total diff  🔴 HIGH · effort M
**Blast radius:** 1.85B prod input tokens; ~9% over-count on multi-turn sessions (input + cache-read). Repo
already knows the fix (deferred to "v6 §A2").
**Fix shape:** compute turn input/cache as `total_token_usage(end) − total_token_usage(start)` so re-emitted /
rate-limit frames are naturally excluded; OR keep delta-summing but drop a turn's first `token_count` when its
`total_token_usage` has not advanced past the prior turn's end. Handle edges: cross-tick start/end totals
(persist prior-turn cumulative anchors — the deferred piece), missing `total_token_usage` fallback,
`flushOpenTurn` truncated turns.
**Files:** `src/agent-gateway/parsers/codex/codex.utils.ts:341-363`; `extractors/usage.ts:4-28,67-74` (also fix
the stale `:4-8` docstring — it says "use latest" but the code SUMS); `services/codex-parse-chat.service.ts:244-262,280-298`;
`codex-finalize-turn.service.ts:305-326`.
**Risk:** cross-tick anchor persistence is the hard part; a half-fix that ignores partial-turn captures could
under-count.

## Rank 3 — F3: null the Gemini `cache_creation` mapping (5.9.10 is visible-output)  🔴 HIGH · effort S
**Blast radius:** removes Σ7.27M double-representable tokens from the column. **Latent today** (downstream sums
the 4 columns DISJOINTLY, so no live double-count) but the column holds wrong data and is a landmine for any
future `input+output+cacheRead+cacheCreation` total.
**Fix shape:** stop mapping proto `5.9.10 → cacheCreationInputTokens` for Gemini (set null/zero) — it
phantom-copies a slice already inside `outputTokens`. Optionally map the unmapped `5.9.9 → a real
reasoning/thoughtsTokens` field if the product wants the breakdown (requires a schema column + product decision —
note `AgentCallRecord` has no reasoning column today, consistent with Codex which also drops reasoning). Leave
`outputTokens` (`5.9.3`) untouched — it is correct.
**Files:** gateway `src/sources/gemini/step-decode.ts:44` (the `5.9.10` mapping); `:41-43` unchanged; nest
`gemini.utils.ts:408-438` unchanged.
**Risk:** very low (one mapping line). Gate on the rank-3 consumer check above.

## Rank 4 — Upsert shrink-guard (covers F4-CC + new Codex re-attach + broad-column corruption)  🔴 HIGH · effort M
**Blast radius:** subset of 1,274 CC idle flushes resumed on the same `promptId` + subset of 134+2 Codex aborts
that re-emit `task_started`; silent under-count today, no metric. One guard neutralizes three problems at once.
**Fix shape:** in the `ON CONFLICT DO UPDATE`, add to the `WHERE` (alongside
`EXCLUDED.last_capture_watermark_end > existing`) a clause that refuses the write when
`EXCLUDED.input_tokens + output_tokens < existing input + output` (or merge usage when re-emitting the same
`promptId`/`turnId`). Protects not just token columns but the ~30 content columns (`final_text`,
`result_content`, …) the same WHERE gates.
**Files:** `src/agent-gateway/parse/services/parse-batch-upsert.service.ts:504-545` (WHERE + SET); complement
with parser-side guards (`claude-code-parse-chat.service.ts:150-157,216-220`; `codex-parse-chat.service.ts:236`).
**Risk:** resolve the **F4 watermark pivot** first. An over-strict guard could block legitimate corrections —
pair with a metric on rejected shrinks.

## Rank 5 — F4 / orphan-drop: re-link or count post-idle-flush continuation records  🔴 HIGH · effort M
**Blast radius:** every post-flush assistant token on a mid-tool-loop resume is lost today, silently — possibly
LARGER than the F4 overwrite footprint.
**Fix shape:** carry `openPromptId` across the idle-flush boundary (or re-link orphan assistant/tool_result
chunks to the prior open turn) so continuations re-attach instead of being dropped; **at minimum add a counter**
on the orphan-drop path to size it in prod before changing behavior.
**Files:** `src/agent-gateway/parsers/claude-code/services/claude-code-parse-chat.service.ts:216-220` (orphan
drop), `:439-443` (lineage nulling), `:392-407` (existing `partial_turn_reset` metric to mirror).
**Risk:** re-linking changes turn boundaries — validate against deterministic-id + finalize so it doesn't create
duplicate turns. Add the counter first. Shares the F4 watermark pivot with rank 4.

## Rank 6 — Codex re-attach guard: extend duplicate-`task_started` check to `lastEmittedTurnId`  🟠 MED · effort S
**Blast radius:** whichever of the 134 `turn_aborted` + 2 `idle_timeout` Codex flushes re-emit `task_started`
post-flush. Largely covered defensively by rank 4; this is the targeted parser-side fix.
**Fix shape:** at the duplicate-`task_started` guard, also ignore (or alarm on)
`newTurnId === acc.lastEmittedTurnId` so a re-emitted `task_started` for an already-flushed turn is dropped
rather than opening a fresh post-flush-only turn that overwrites the original. Converts a silent under-count into
a no-op + a sizable metric.
**Files:** `src/agent-gateway/parsers/codex/services/codex-parse-chat.service.ts:233-242,166-173,271`.
**Risk:** low; mirrors existing in-open-turn dedup. Add a metric to size the abort-replay population.

## Rank 7 — Claude Desktop version-prefix resolution fix  🟠 MED · effort S · SEQUENCE AFTER 1/4/5
**Blast radius:** currently 0 prod Desktop rows (structural total loss) → fix unblocks the entire source. But
once resolved, Desktop **inherits** F1/F4 under-counts, so ship ONLY after ranks 1/4/5 land.
**Fix shape:** register `CLAUDE_DESKTOP` under a prefix-stripping scheme (mirror `geminiScheme`'s `antigravity/`
strip for `claude-desktop/`) OR correct the gateway/nest version contract so the prefixed `agentSchemaVersion`
resolves; add a reference test resolving a real `claude-desktop/v2` value end-to-end. Also fix the
`parsers.versions.ts:182-186` comment and `desktop-routing.md` ("0 rows = version short-circuit").
**Files:** nest `src/agent-gateway/parsers/parsers.versions.ts:163-178` (geminiScheme pattern), `:182-190`;
`parse-process-chat.service.ts:125-145`; gateway `claude-desktop/collect.ts:171-180`,
`claude-desktop.constants.ts:15`.
**Risk:** turning it on exposes a known-undercounting path — gate behind ranks 1/4/5.

## Rank 8 — Cursor local-only token collection (feature-add: Option A floor)  🟠 MED · effort M
**Blast radius:** adds a real context-size + productivity signal for 1,670 Cursor ACRs (currently all-null); no
detection-correctness impact → lower than the detections. Full design in `CURSOR_TOKEN_COLLECTION.md` §3.
**Fix shape:** **P1 (nest-only, data already in S3 untrimmed):** extract composer context fields
(`contextTokensUsed/Limit/Percent`, `promptTokenBreakdown`, `modelName`, `totalLinesAdded/Removed`) in
`cursor/extractors/usage.ts` + add `declaredFields`. **P2 (gateway one-line):** add
`contextWindowStatusAtCreation` to `CURSOR_BUBBLE_KEEP_KEYS` for the per-turn series (new captures only).
**Honor gauge-vs-flow:** context size goes to `agent_metadata` as MAX/latest, NEVER summed into `inputTokens`;
billed columns stay null. **Option B** (estimated `outputTokens` with `tokens_are_estimated`) is opt-in and must
be visibly flagged. **Option C** held (needs a no-downstream-sum guarantee).
**Files:** nest `src/agent-gateway/parsers/cursor/extractors/usage.ts:28-50`; `cursor.utils.ts:42-63`;
`parsers.versions.ts` (declaredFields); gateway `src/sources/cursor/process-rows.ts:56-67`
`CURSOR_BUBBLE_KEEP_KEYS`.
**Risk:** the gauge-vs-flow trap (do NOT sum context size into `inputTokens`). P2 is retroactive only on new
captures. Option B estimates must be flagged.

## Rank 9 — `deterministicRecordId` fallback hardening  🟢 LOW · effort S
**Blast radius:** latent — moot on Node 24 (blake2b512 present); guards a future runtime regression that would
mint different ids and double-count at rollup.
**Fix shape:** convert the silent `console.warn` on the sha256 fallback into a boot-time refusal or a
metric/Sentry tag.
**Files:** `src/agent-gateway/parsers/parsers.utils.ts:23-27,47-58`.
**Risk:** a boot-refusal must be overridable so it can't brick a legitimately FIPS-constrained deploy.

## Rank 10 — Web "Token Usage" KPI label + Cursor null display  🟢 LOW · effort S · SEQUENCE AFTER 3
**Blast radius:** display-only; no stored-data change.
**Fix shape:** update the KPI subtitle to state it includes cache-read (value is `input+output+cacheRead`, a
3-column sum); render Cursor token cells as "not captured" (null-aware) instead of 0 so genuine-zero is
distinguishable from no-data.
**Files:** proxai_web `app/dashboard/organization/(workspace)/analytics/acr/_components/agent-metrics-dashboard.tsx:45,49`;
`acr-stats-org-source-table.tsx:101-112`.
**Risk:** none beyond copy accuracy.

---

## Suggested sequencing
1. **Resolve the two verify-before-fix pivots** (F4 watermark; F3 consumer read).
2. **Quick wins:** rank 3 (Gemini mapping, S) + rank 6 (Codex re-attach guard, S) + the metrics on ranks 4/5
   orphan-drop (size before behavior change).
3. **Core corrections:** rank 1 (F1, L) and rank 2 (F2, M) — the two biggest live correctness issues.
4. **Upsert guard:** rank 4 (after the watermark pivot) — neutralizes F4-CC + Codex re-attach + content corruption together.
5. **Orphan-drop behavior change:** rank 5 (after its metric quantifies it).
6. **Unblock Desktop:** rank 7 — only after 1/4/5.
7. **Feature-add + display:** rank 8 (Cursor), rank 10 (KPI label after F3), rank 9 (fallback hardening) as capacity allows.

All ranks are detections/fixes to the existing pipeline except rank 8 (Cursor feature-add) — kept lowest per the
"detections first" priority. Final sequencing is the operator's call; this is the recommended order.
