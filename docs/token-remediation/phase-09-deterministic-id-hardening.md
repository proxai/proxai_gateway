# Phase 9 — deterministicRecordId fallback hardening

- **Status:** ⬜ NOT STARTED
- **Severity:** 🟢 low (latent) · **Effort:** S
- **Repos:** proxai_nest
- **Depends on:** none · **Blocks:** —
- **Source:** VERIFICATION_FINDINGS.md §11.5 · IMPLEMENTATION_PLAN.md Rank 9

## Concern this phase eliminates
`deterministicRecordId` silently falls back to sha256-truncation when `blake2b512` is unavailable (very old Node
/ FIPS-mode OpenSSL). The fallback is self-deterministic but mints DIFFERENT ids than blake2b for the same
`(agent, chatId, turnId)`. A fleet straddling that boundary would re-parse a turn as a NET-NEW PK instead of an
upsert → double-counting usage at the `(user, chat)` rollup. Only a `console.warn` fires today. Currently moot on
Node 24, but it is a silent duplicate-row source if a runtime ever regresses. When merged, the fallback is loud
(boot refusal or metric/Sentry) instead of silent.

## Background (read first)
- `proxai_nest/src/agent-gateway/parsers/parsers.utils.ts:23-27` (the fallback) and `:47-58` (id derivation).

## Change spec
### proxai_nest
- Convert the silent `console.warn` on the sha256 fallback into either a boot-time refusal (with an explicit
  override env-var so a legitimately FIPS-constrained deploy isn't bricked) OR a `Logger.metric` + Sentry tag so
  a non-blake2b runtime is alarmed rather than silently producing duplicate ids.
- If using a metric, register it in `src/telemetry/metric-kind-registry.ts`.

## Tests (verifier checks these)
- Simulate blake2b512 unavailable → assert the chosen loud behavior (throw-with-override OR metric/Sentry), not a
  bare console.warn.
- Normal path (blake2b present) unchanged.

## Acceptance criteria (100% = all true)
- [ ] Fallback is loud (boot refusal w/ override, or metric+Sentry); no silent path remains.
- [ ] Override mechanism documented (if boot-refusal chosen).
- [ ] Tests above green.

## Merge checklist
- [ ] proxai_nest PR merged

## Orchestrator quick-check (run on "Phase 9 done")
- `grep -n "blake2b\|sha256\|console.warn\|Logger" proxai_nest/src/agent-gateway/parsers/parsers.utils.ts`
  → confirm the warn was replaced with a loud path.

## Data-refresh implication
None — forward-protective only.
