# Phase 10 — Web "Token Usage" KPI label + Cursor null display

- **Status:** ⬜ NOT STARTED
- **Severity:** 🟢 low (display-only) · **Effort:** S
- **Repos:** proxai_web
- **Depends on:** Phase 3 (so the label reflects post-fix columns) · **Blocks:** —
- **Note:** Cursor collection (Phase 8) is DEFERRED, so Cursor stays all-null — which makes the honest
  "not captured" display here MORE relevant (it's the permanent state, not a transient one). No dependency on Phase 8.
- **Source:** VERIFICATION_FINDINGS.md §11.5 · IMPLEMENTATION_PLAN.md Rank 10

## Concern this phase eliminates
Two display defects: (1) the "Token Usage" KPI value is `input + output + cacheRead` (a 3-column disjoint sum)
but its subtitle reads "Input + output tokens" — for Gemini, cacheRead is ~52% of the prompt, so the label
materially understates. (2) Cursor's all-null token fields are coerced to 0 (`?? 0`), so Cursor's KPI shows `0` —
indistinguishable from genuine zero usage rather than "not captured." When merged, the label is accurate and
Cursor reads "not captured."

## Background (read first)
- KPI computation/label: `proxai_web` `app/dashboard/organization/(workspace)/analytics/acr/_components/agent-metrics-dashboard.tsx:45,49`
  (value = `actual.totalTokenCount + cached.totalTokenCount` = input+output+cacheRead; subtitle "Input + output tokens").
- Cursor null→0 coercion + source table: `acr-stats-org-source-table.tsx:101-112`.
- This is NOT an F3 double-count (cacheCreation is excluded from the KPI); purely a label + null-display fix.

## Change spec
### proxai_web
- Update the KPI subtitle to state it includes cache-read tokens (value is a 3-column input+output+cacheRead sum).
- Render Cursor token cells null-aware: show "not captured" (or em-dash) instead of `0` when the underlying
  values are null, so genuine-zero is distinguishable from no-data.
- **Cross-agent comparison now works directly on `inputTokens`** because Phase 1's column normalization makes
  `inputTokens` = fresh input for every agent (Claude folds `cache_creation` into it; `cacheCreation` is null
  everywhere) — see ROADMAP "Column normalization" + `analysis/CROSS-SOURCE-NORMALIZATION.md`. So the dashboard
  compares `inputTokens` / `cacheReadInputTokens` / `outputTokens` as-is; do NOT special-case providers and do
  NOT add a separate `cacheCreation` term (it's null / folded). This is the storage-level fix for the false ~20×
  gap (Claude vs Gemini fresh_input is ~1.04×, not 20×); the only display work left here is the KPI subtitle +
  Cursor null rendering above.

## Tests (verifier checks these)
- Component test: KPI subtitle text reflects cache-read inclusion.
- Cursor row with null token fields renders "not captured", not `0`; a token-bearing agent with real 0 still
  renders `0`.

## Acceptance criteria (100% = all true)
- [ ] KPI subtitle accurately describes the 3-column value.
- [ ] Cursor null tokens render as "not captured", distinct from genuine 0.
- [ ] Tests above green.

## Merge checklist
- [ ] proxai_web PR merged

## Orchestrator quick-check (run on "Phase 10 done")
- `grep -n "Input + output\|not captured\|totalTokenCount" proxai_web/app/dashboard/organization/(workspace)/analytics/acr/_components/agent-metrics-dashboard.tsx`
  → confirm the subtitle update and null-aware rendering.

## Data-refresh implication
None — display-only.
