# Phase 5 — Claude Code idle-flush orphan-drop

- **Status:** 🟡 Stage A DONE (orphan-drop counter live + registered) · Stage B DEFERRED (2026-06-26 — see Decision)
- **Severity:** 🔴 high · **Effort:** M
- **Repos:** proxai_nest
- **Depends on:** Phase 4 recommended (defense-in-depth) · **Blocks:** Phase 7
- **Source:** VERIFICATION_FINDINGS.md §10.3, §11.2, §11.3 · IMPLEMENTATION_PLAN.md Rank 5

## Decision (2026-06-26) — Stage A shipped; Stage B deferred (design preserved)

**Stage A (measure): DONE.** The orphan-drop site (`claude-code-parse-chat.service.ts` ~:216-234) already emits `agent_gateway_parser_claude_orphan_assistant_dropped_total` with a `reason` label (`post_idle_flush` vs `pre_first_prompt`), registered in `src/telemetry/metric-kind-registry.ts`. The loss is now measurable.

**Stage B (recover): DEFERRED.** Rationale:
- **agent-gateway is pre-production** — no live traffic, no real data lost today (latent bug).
- **Footprint unmeasured** — Stage A sizes it once real traffic flows; no number yet to justify the cost.
- **Trigger is inherently rare** — needs a turn to stay *open* across the idle threshold AND resume the *same* promptId; normal usage resumes with a new prompt (a new turn, unaffected). Realistic hit = long autonomous tool-loops, not interactive use.
- **The correct fix is non-trivial** (the cheap fixes silently fail — see below). YAGNI: measure first, build when the counter justifies it.

**Revisit Stage B when:** the prod counter shows a material `post_idle_flush` footprint; OR before the Phase 11 backfill if historical recovery of these orphans is wanted (the re-parse drops them without Stage B).

### Preserved design — "watch-and-recover" (from a 3-persona brainstorm, 2026-06-26)
The vetted design if/when Stage B is built (the naïve fixes were rejected):
- **Reject naïve re-link:** idle-flush nulls the replay window (`openCaptureFirst*`), so a re-emit carries continuation-only usage < the stored row → **F4 shrink-guard vetoes it → silent loss.** Also risks inverted `parentTurnId` (lineage cycle) + double audit rows.
- **Reject naïve carry-`openPromptId`:** keeping the turn open resurrects the **zombie strand** (permanent `ACTIVE`, pins parse-lag, cron re-selects forever) + flips `flush_reason` on the next boundary.
- **Build (C):** decouple *emitted* from *open*. On idle-flush close: emit ACR(P) as today, but **preserve the replay window** + set a new accumulator field `idleFlushedPromptId = P`, and **null `openPromptId`** (so `hasOpenTurn` → false → chat reaches COMPLETED, no zombie). On a post-flush orphan for P: **re-open** (window intact → re-materialize P's full records + the continuation) and **finalize immediately that tick** → a same-id, grown-usage UPDATE that F4 absorbs cleanly (watermark advances ✓, shrink-guard passes ✓, no duplicate ✓), then clear the watch state.
- **Guardrails (panel-flagged, must bake in):** additive buffer (re-materialize originals or it self-vetoes); do NOT re-parent (keep P's original `parentTurnId`); do NOT re-write the `agent_idle_flushes` audit row (distinct `flush_reason` e.g. `orphan_relink`, or a uniqueness guard); ABORT the re-emit if the replay truncates at `PARSE_FETCH_BATCH_LIMIT` (a short count → veto → silent loss); hand off cleanly when a genuinely new promptId arrives; scope to BOTH post-flush paths (the `post_idle_flush` label also fires on natural-boundary closes); add a Phase-7 (`source_platform=claude-code-desktop`) test (the CC parser ships to Desktop verbatim).
- **Cost if built (bounded):** ~1 S3 replay + 1 UPSERT per *recovered* turn (only the orphan population; zero for normal turns); NO extra outbox/sweep/breadcrumb-handler load (the re-emit is SUCCESS→SUCCESS, which F4's trigger logic excludes). Add `agent_gateway_parser_orphan_relinked_total`; the existing drop counter should trend to ~0 (success metric).
- **Accumulator change:** add `idleFlushedPromptId: string | null` + bump `ACCUMULATOR_VERSION`.

The original Stage A/B spec is preserved below for reference.

---

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
