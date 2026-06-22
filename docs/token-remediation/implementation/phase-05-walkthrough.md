# Phase 5 Walkthrough — Claude Code Orphan Drop Sizing (Stage A)

This document walks through the implementation of Phase 5 (Stage A) of the Token Remediation plan. 

## 1. Context and Problem Statement
When a Claude Code turn is open and quiet for 24 hours, the `idle-flush` cron force-finalizes the turn. This clears the open-turn lineage, setting `acc.openPromptId = null`.
On subsequent parse ticks, the post-flush continuation records (assistant text and `tool_result` envelopes) arrive. Since they carry no `promptId`, and `openPromptId` is now `null`, these records hit the orphan branch of the parser and are silently dropped. Consequently, all continuation tokens are lost, and the system under-reports the total tokens consumed.

Stage A implements a sizing counter to measure this data-loss path in production before recovering the tokens in Stage B.

---

## 2. Implementation Overview

### 2.1. Parser Changes (`claude-code-parse-chat.service.ts`)
We added two per-tick counters to size the orphan drops:
- `orphanDroppedPostFlush`: Dropped records that arrive after a turn was finalized and its open-turn lineage was cleared (the data-loss path we want to measure).
- `orphanDroppedPreFirstPrompt`: Benign assistant chatter arriving before any user prompt has started.

To avoid hot-loop metric emissions (which can lead to event loop lag and console/drain pressure), these metrics are accumulated locally during the loop and emitted exactly once at the end of the tick, guarded on values `> 0`.

### 2.2. Metric Registration (`metric-kind-registry.ts`)
The new counter metric `agent_gateway_parser_orphan_dropped_total` was registered alphabetically in `METRIC_KIND_REGISTRY` as a `'counter'`:
```ts
    agent_gateway_parser_open_turn_replay_truncated_total: 'counter',
    // Per-tick count of promptId-less records dropped because no turn was open
    // (accumulated then emitted once per tick); reason ∈ {post_flush,
    // pre_first_prompt}. `post_flush` sizes the idle-flush continuation loss.
    agent_gateway_parser_orphan_dropped_total: 'counter',
    agent_gateway_parser_partial_turn_reset_total: 'counter',
```

### 2.3. Unit Tests (`claude-code-parse-chat.service.spec.ts`)
We added three isolated unit tests under the `finalizeTurn — status derivation` block to verify correct counter behavior:
1. `counts a post-flush continuation orphan once per tick under reason=post_flush`
2. `counts a pre-first-prompt orphan under reason=pre_first_prompt`
3. `does not count an orphan when a fresh prompt opens its own turn` (regression guard verifying a new user prompt behaves normally without firing the orphan metrics).

---

## 3. Pre-flight Watermark Assumption Re-Confirmation

We re-confirmed the watermark behavior of `idle-flush` against the parser and upsert codebase:
* **Watermark Nuance**: The `idle-flush` tick does not strictly advance the `last_processed_watermark` cursor. Instead, it replays the existing open-turn captures up to the current watermark. During the database upsert, because the incoming watermark is equal to (not greater than) the existing database watermark, the database cursor updates fallback to the `ELSE` branch (leaving it unchanged). Meanwhile, the accumulator blob is overwritten with the cleared open turn.
* **Conclusion**: The next tick fetches captures starting after the last advanced watermark (representing the new post-flush chunks). Since `openPromptId` is cleared, this tick uses the normal chunk iteration method (`iterateChunkRecords`) over those new chunks, hitting the orphan branch and dropping them.
* **Verification**: The pre-flight conclusion holds: this is indeed a post-flush continuation drop of new captures, rather than a replay/overwrite of already-processed captures.

---

## 4. Stage B Deferred Design Summary
Stage B (recovery) is deferred until production sizing metrics from Stage A are analyzed. 
* **Proposed Recovery Mechanism (Option B1)**: 
  * Save the finalized turn's lineage (`lastFlushedTurnId`, `lastFlushedFirstCaptureId`, `lastFlushedFirstWatermarkStr`) in the accumulator during `flushOpenTurn` instead of discarding it.
  * When an orphan record arrives (`openPromptId === null` but `lastFlushedTurnId !== null`), re-open the turn by restoring its lineage into the active accumulator.
  * Let the normal parser run-loop process the tick without immediately finalizing; on the next tick, replay starts from the first watermark and merges the original turn records with the continuation records, writing an idempotent update to Postgres.
* **Safety / Dependencies**: Option B1 relies on Phase 4's shrink-guard being in the database upsert path to guarantee that subsequent re-emissions never shrink token counts if captures are evicted or modified.

---

## 5. Verification Results

All tests have been run and verified locally:
1. **Typecheck passes**: `bun run typecheck` / `tsc --noEmit` checks clean.
2. **Parser Unit Tests**: All 57 tests passed successfully.
3. **Metric Registry Specification**: Verified clean.
