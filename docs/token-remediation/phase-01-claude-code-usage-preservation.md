# Phase 1 — Claude Code usage preservation (F1)

- **Status:** ⬜ NOT STARTED
- **Severity:** 🔴 critical · **Effort:** L
- **Repos:** proxai_gateway + proxai_nest
- **Depends on:** none · **Blocks:** Phase 7 (Desktop inherits this fix), Phase 11 (no historical backfill — see below)
- **Source:** VERIFICATION_FINDINGS.md §4, §10.6, §11.1 · IMPLEMENTATION_PLAN.md Rank 1

## Concern this phase eliminates
Claude Code (the most-used agent, ~15.5k ACRs) systematically UNDER-counts tokens. The gateway's
`isDialogueRecord` filter drops every assistant record containing a `tool_use` block BEFORE upload, so each
intermediate tool-calling API call's independent per-call `usage` never reaches nest; nest then sums usage over
the surviving (text-only) records only. ~75% of cache/output telemetry is lost. When this phase is merged on
both repos, **future** Claude Code captures carry the full per-call usage and nest sums the whole agentic loop.

## Background (read first)
- Drop mechanism: `proxai_gateway/src/sources/claude-code/collect.ts:142-203` (`isDialogueRecord`). A PURE
  `tool_use` record is dropped at the `hasText` gate `:184` (`if (!hasText) return false`); a MIXED text+tool_use
  record is dropped at `:200-202` (`hasToolUse → return !hasToolUse`). Only kept lines are uploaded
  (`:248-262`, body built from `kept` at `:355-373`).
- Proof the dropped records carry real per-call usage: the gateway's own fixture
  `proxai_gateway/src/sources/claude-code/tests/fixtures/session-basic.jsonl:5` (usage input:1/output:2) and
  `:7` (a pure tool_use record with its OWN usage input:3/output:4). Anthropic emits usage per request (not
  cumulative).
- Nest sums survivors only: `proxai_nest/src/agent-gateway/parsers/claude-code/claude-code.utils.ts:400-414`
  (aggregateUsage sums `message.usage`), called at
  `proxai_nest/src/agent-gateway/parsers/claude-code/services/claude-code-finalize-turn.service.ts:99`.
- No usage side-channel exists (grep `usage|token` in `proxai_gateway/src/sources/claude-code/*` is empty).

## Token semantics (SETTLED — no decision needed)
Store the true **billed** total = the SUM of every distinct per-call `usage` across the agentic loop. Anthropic
returns `usage` per API request and bills each separately (not cumulative), so summing per-call usage IS the
billed total — this is the same goal used for every agent (Codex recovers it via cumulative diff; Gemini via
per-step sum). `aggregateUsage` already SUMS; this phase only makes that sum COMPLETE by stopping the gateway
from dropping the tool_use-bearing calls. There is NO "final context size" alternative — that is a different
metric we are not using. Do not re-open this.

**Column normalization (decided 2026-06-17 — see ROADMAP "Column normalization"):** store `inputTokens` =
**fresh input** = `input_tokens + cache_creation_input_tokens` (summed per call across the turn), and set
`cacheCreationInputTokens` = **null** (folded in). Anthropic's cache-creation tokens are full-rate fresh input;
folding them makes `inputTokens` mean the same "fresh input" as Gemini/Codex and stops Claude's input looking
abnormally low (median 21 → ~18.4k). Keeping the column populated AND inside input would double-count (F3 shape).
No $ is computed today, so losing the explicit write-count is safe; if needed later, stash raw
`{input_tokens, cache_creation_input_tokens}` in `agent_metadata` — do not un-fold.

## Change spec
### proxai_gateway
- Split display-filtering from telemetry. Either (i) upload ALL session lines, or (ii) add an
  `isDialogueVisible` flag so display-only records are marked but their `usage` is still uploaded.
  - `src/sources/claude-code/collect.ts:142-203` (`isDialogueRecord`) and the upload filter at `:248-262` /
    body build `:355-373`.
- Net effect: every assistant record's `usage` block reaches the capture body.

### proxai_nest
- `src/agent-gateway/parsers/claude-code/claude-code.utils.ts:400-414` — ensure aggregateUsage now sums over the
  full set of usage-bearing records (including the previously-dropped ones); confirm no double-count if the
  gateway now sends both a visible flag and the record.
- **Fold cache-creation into input:** set `inputTokens` (per call) = `input_tokens + cache_creation_input_tokens`
  and emit `cacheCreationInputTokens = null`. Apply where the per-call usage is mapped into the scalar spine
  (`src/agent-gateway/parse/build-scalar-spine.ts:162` writes `cacheCreationInputTokens` today). Verify NOTHING
  downstream still adds a separate creation term (it's now inside input).
- `.../services/claude-code-finalize-turn.service.ts:99` — unchanged call, but verify the turn boundary still
  groups the now-larger record set correctly.

## Tests (verifier checks these)
- Gateway: a fixture turn = 1 user + N tool_use assistant calls + final text; assert all N per-call `usage`
  blocks survive to the upload body (extend `tests/fixtures/session-basic.jsonl` + `collect.test.ts`).
- Nest: a turn with tool_use + text records aggregates to the SUM of all per-call usage (not just the text
  record's). Add/adjust a `claude-code.utils` spec asserting the summed totals.
- Regression: pure-text-only turns still produce identical results.

## Acceptance criteria (100% = all true)
- [ ] tool_use-bearing assistant records' `usage` reaches nest (gateway no longer discards it pre-upload).
- [ ] nest aggregateUsage sums the full loop; a multi-tool-call turn's stored input/output/cache > the old
      text-only sum, by the dropped calls' usage.
- [ ] No regression for text-only turns; no double-count.
- [ ] `inputTokens` = `input_tokens + cache_creation_input_tokens` (fresh input); `cacheCreationInputTokens` emitted
      as null; a test asserts the fold and asserts no path sums a separate creation term.
- [ ] Tests above added and green.

## Merge checklist
- [ ] proxai_gateway PR merged
- [ ] proxai_nest PR merged

## Orchestrator quick-check (run on "Phase 1 done")
- `grep -n "isDialogueVisible\|usage" proxai_gateway/src/sources/claude-code/collect.ts` → confirm usage is no
  longer gated out for tool_use records.
- Confirm the new gateway + nest tests exist and assert the summed-loop behavior.
- Spot a recent Claude Code capture (or test fixture) shows tool_use usage flowing through.

## Data-refresh implication
❌ **NOT backfillable.** The dropped records were discarded BEFORE S3 upload, so historical Claude Code captures
do not contain the lost usage. Only captures taken after this merge are correct. Phase 11 cannot recover CC
history; communicate this.
