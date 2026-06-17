# Phase 5 — Claude Code idle-flush orphan-drop

- **Status:** ⬜ NOT STARTED
- **Severity:** 🔴 high · **Effort:** M
- **Repos:** proxai_nest
- **Depends on:** Phase 4 recommended (defense-in-depth) · **Blocks:** Phase 7
- **Source:** VERIFICATION_FINDINGS.md §10.3, §11.2, §11.3 · IMPLEMENTATION_PLAN.md Rank 5

## Concern this phase eliminates
After an idle-flush nulls the open turn's lineage, every post-flush ASSISTANT and `tool_result` chunk (which
carry no `promptId`, only `parentUuid`) is silently DROPPED as an orphan. Per pre-flight this is the **dominant**
Claude Code idle-flush data-loss path (the F4 same-ACR overwrite is unlikely because idle-flush advances the
shared watermark). For a mid-tool-loop resume, every post-flush assistant token is lost — with no metric, no log,
no Sentry. When merged, post-flush continuations are counted (re-linked) or at minimum measured.

## Background (read first)
- Orphan drop: `proxai_nest/src/agent-gateway/parsers/claude-code/services/claude-code-parse-chat.service.ts:216-220`
  (`continue` for promptId-less chunks when `acc.openPromptId` is null).
- Lineage nulled at idle-flush: `:439-443`.
- The only existing metric is `agent_gateway_parser_partial_turn_reset_total` at `:404`, which fires on the
  defensive partial-state branch (`:392-407`) — NOT on the orphan-drop path. So the orphan-drop is silent.
- Pre-flight: idle-flush advances `agent_parse_states.last_processed_watermark`
  (`parse-process-chat.service.ts:355-399`), so the continuation reads NEW post-flush chunks (the orphan case),
  not re-read old ones (the overwrite case).

## Change spec (two stages — ship the counter first)
### proxai_nest — stage A (measure)
- Add a counter on the orphan-drop path at `:216-220` (mirror the `:404` metric shape) so the prod footprint is
  observable BEFORE changing behavior. Register the metric name in `src/telemetry/metric-kind-registry.ts`
  (required, or it is silently dropped from Grafana).

### proxai_nest — stage B (recover)
- Carry `openPromptId` across the idle-flush boundary, OR re-link orphan assistant/tool_result chunks to the
  prior open turn, so post-flush continuations re-attach and their usage is summed instead of dropped.
- Validate against the deterministic-id + finalize path so re-linking does not create duplicate turns.

## Tests (verifier checks these)
- Simulate: idle-flush emits ACR(X); post-flush chunks contain assistant + tool_result records with no promptId.
  - Stage A: assert the orphan-drop counter increments.
  - Stage B: assert the post-flush usage is attributed (re-linked) rather than dropped, and exactly one ACR per
    logical turn results (no duplicate).
- Regression: a normal new-prompt continuation (new promptId Y) still opens its own turn unaffected.

## Acceptance criteria (100% = all true)
- [ ] Pre-flight watermark assumption re-confirmed in-PR.
- [ ] Stage A counter live + registered in METRIC_KIND_REGISTRY.
- [ ] Stage B: post-flush continuation tokens are counted (or, if deferred, document why and keep the counter).
- [ ] No duplicate turns; no regression for fresh-prompt continuations.
- [ ] Tests above green.

## Merge checklist
- [ ] proxai_nest PR merged

## Orchestrator quick-check (run on "Phase 5 done")
- `grep -n "Logger.metric\|continue" proxai_nest/src/agent-gateway/parsers/claude-code/services/claude-code-parse-chat.service.ts`
  around `:216-220` → confirm the orphan path now emits a metric (and re-links if stage B done).
- Confirm the metric name is in `src/telemetry/metric-kind-registry.ts`.

## Data-refresh implication
✅ **Backfillable.** Orphan continuation records ARE in S3 (drop is in nest, post-upload). Phase 11 re-parse
recovers them once stage B lands.
