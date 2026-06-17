# Phase 8 — Cursor local-only collection (Option A floor)

- **Status:** ⏸️ DEFERRED (2026-06-17 operator decision) — NOT in the active set; Cursor stays all-null for now. This doc is parked for a future revisit, not deleted. The honest "not captured" Cursor display still ships in Phase 10.
- **Severity:** 🟠 medium (feature-add) · **Effort:** M
- **Repos:** proxai_nest + proxai_gateway
- **Depends on:** none · **Blocks:** Phase 10 (Cursor null display)
- **Source:** CURSOR_TOKEN_COLLECTION.md (full design) · IMPLEMENTATION_PLAN.md Rank 8

## Concern this phase eliminates
Cursor contributes all-null token fields. Per-turn BILLED tokens are genuinely absent from Cursor's local data
(confirmed exhaustively), but a conversation-level input-CONTEXT gauge IS stored and unexploited. This phase ships
**Option A** (authoritative context-size + productivity), giving Cursor users a real signal where today there is
nothing. Billed columns stay null (truthful). This is a FEATURE-ADD, not a detection fix — lowest of the
non-display work.

## Background (read first)
Read `../planning/token-issues/CURSOR_TOKEN_COLLECTION.md` §1, §3 in full. Key facts:
- `composerData` rows ship to S3 UNTRIMMED (`proxai_gateway/src/sources/cursor/process-rows.ts` trims only
  `bubbleId:`/`agentKv:` rows) → `contextTokensUsed`/`contextTokenLimit`/`contextUsagePercent`/
  `promptTokenBreakdown`/`modelConfig.modelName`/`totalLinesAdded`/`totalLinesRemoved` are ALREADY in S3.
- Current extractors return authoritative-null: `proxai_nest/src/agent-gateway/parsers/cursor/extractors/usage.ts:28-50`.
- Per-turn `bubble.contextWindowStatusAtCreation.{tokensUsed,tokenLimit}` exists but is trimmed out by
  `CURSOR_BUBBLE_KEEP_KEYS` (`process-rows.ts:56-67`) — needs a one-line gateway add (P2 below), new captures only.
- **Gauge-vs-flow rule (critical):** context size is a GAUGE — report MAX/latest, NEVER SUM across turns, and do
  NOT place it in the billed `inputTokens` column. Put it in `agent_metadata`.

## Decision required before coding
- Option A only (recommended), or also Option B (estimated `outputTokens` with `tokens_are_estimated=true`)?
  Option B must be visibly flagged so it doesn't dilute measured counts. Option C (context-as-input) is held —
  do NOT ship without a no-downstream-sum guarantee.

## Change spec
### proxai_nest — P1 (data already in S3)
- `src/agent-gateway/parsers/cursor/extractors/usage.ts:28-50` + `cursor.utils.ts:42-63` + `declaredFields` in
  `parsers.versions.ts` — extract the composer context fields into `agent_metadata` (gauge: latest/max), keep the
  four billed columns null.
### proxai_gateway — P2 (new captures only)
- `src/sources/cursor/process-rows.ts:56-67` `CURSOR_BUBBLE_KEEP_KEYS` — add `contextWindowStatusAtCreation`
  (and optionally `turnDurationMs`/`thinkingDurationMs`) so the per-turn gauge survives the bubble trim.

## Tests (verifier checks these)
- Nest: a composer fixture with `contextTokensUsed` → asserted into `agent_metadata` (gauge), billed columns
  still null. A multi-turn fixture: confirm the value is NOT summed into `inputTokens`.
- Gateway: `contextWindowStatusAtCreation` survives the bubble trim after the keep-key add.

## Acceptance criteria (100% = all true)
- [ ] Option A/B decision recorded.
- [ ] Cursor composer context fields surfaced in `agent_metadata`; billed columns remain null.
- [ ] Gauge semantics honored (no SUM into inputTokens; per-turn series uses MAX).
- [ ] Tests above green.

## Merge checklist
- [ ] proxai_nest PR merged
- [ ] proxai_gateway PR merged (P2 keep-key)

## Orchestrator quick-check (run on "Phase 8 done")
- `grep -n "contextTokensUsed\|contextWindowStatusAtCreation" proxai_nest/src/agent-gateway/parsers/cursor/ proxai_gateway/src/sources/cursor/process-rows.ts`
  → confirm extraction + keep-key add.
- Confirm a test asserts the gauge is NOT in the summed `inputTokens` column.

## Data-refresh implication
P1 fields are retroactively available (already in S3) — a re-parse (Phase 11) backfills the composer-level gauge
on existing Cursor ACRs. P2 per-turn series is new-captures-only.
