# Phase 6 Walkthrough — Codex Re-attach Guard

This document details the walkthrough of the implementation and test verification of **Phase 6: Codex Re-attach Guard** under the Token Remediation plan.

---

## 1. Executive Summary

During a Codex session retry or re-attach flow, Codex may re-emit a `task_started{X}` event for a turn that has already been finalized and flushed into a database record. 
- **The Issue:** The previous duplicate guard in the parser only dropped `task_started` events if the turn was still currently open (`acc.openTurnId === X`). Once a turn flushed, `acc.openTurnId` was cleared to `null`, letting a post-flush re-emit slide past the guard. This opened a fresh, smaller-window turn with the same turn ID, generating a duplicate record containing only post-flush token usage. Because it was generated in a later capture (higher watermark), the watermark-gated upsert overwrote the original (larger) record, resulting in token under-counting.
- **The Solution:** Added a re-attach guard checking if the incoming `task_started` turn ID matches `acc.lastEmittedTurnId` (the turn we already emitted). When matched, the event is dropped, the event is counted under a new metric, and stray post-flush events are ignored.

---

## 2. Implementation Details

We touched exactly **three** files in `proxai_nest`:

### 2.1 Parser Guard Addition
In `src/agent-gateway/parsers/codex/services/codex-parse-chat.service.ts`:
Inserted the re-attach guard in the `task_started` event handler right after the existing in-flight duplicate check:

```typescript
          // Same turn_id repeating: ignore. Codex re-emits task_started
          // on some retry / re-attach flows; treating it as a fresh
          // open would discard buffered lines.
          if (acc.openTurnId === newTurnId) {
            metricAccumulator.recordEvent(
              'agent_gateway_parser_duplicate_task_started_total',
              { agent: 'CODEX' },
            );
            continue;
          }

          // Re-emitted task_started for a turn already finalized into a
          // record. `acc.openTurnId` was cleared on flush, so the guard
          // above can't catch this. Opening it fresh would re-derive the
          // SAME deterministic record id from a post-flush-only line window
          // (no S3 replay on re-open) with a HIGHER capture watermark, and
          // the watermark-gated upsert would overwrite the original record
          // with that smaller token sum. Drop it: the original record
          // already covers this turn, and a cold-start re-parse is the only
          // correct way to re-derive it.
          if (acc.lastEmittedTurnId === newTurnId) {
            metricAccumulator.recordEvent(
              'agent_gateway_parser_reattach_dropped_total',
              { agent: 'CODEX' },
            );
            continue;
          }
```

### 2.2 Metric Registration
In `src/telemetry/metric-kind-registry.ts`:
Registered the new metric `agent_gateway_parser_reattach_dropped_total` as a `counter` alphabetically to allow it to pass validation and flow into the Prometheus/Grafana pipeline:

```typescript
    agent_gateway_parser_provider_inferred_total: 'counter',
    // Verified: a re-emitted task_started for an already-emitted Codex turn was
    // dropped by the re-attach guard. Monotonic count of drops, accumulated per
    // tick → counter. Sizes the abort/idle-flush re-attach population.
    agent_gateway_parser_reattach_dropped_total: 'counter',
    agent_gateway_parser_replay_filtered_other_composer_total: 'counter',
```

### 2.3 Unit Tests Addition
In `src/agent-gateway/parsers/codex/tests/codex-parse-chat.service.spec.ts`:
Appended a new `describe` block containing three unit tests testing the edge cases:
1. **Single-tick drop:** Drops a re-emitted `task_started` for a turn already emitted within the same execution tick, preserving the original record and token counts.
2. **Cross-tick drop:** Drops a post-flush re-emitted `task_started` that arrives in a later tick/capture, correctly inspecting `acc.lastEmittedTurnId` carried in the persisted accumulator.
3. **In-open-turn duplicate regression check:** Assures that an in-flight duplicate `task_started` for a turn that is *still open* still triggers the original duplicate-event check and preserves the buffered context.

---

## 3. Verification & Testing

All verification steps passed successfully.

### 3.1 Typecheck Output
```bash
$ bun run typecheck
$ tsc --noEmit
# Completed successfully with no errors or warnings
```

### 3.2 Unit Test Execution
We executed the parser tests via `vitest`:

```bash
$ bun run test:unit src/agent-gateway/parsers/codex/tests/codex-parse-chat.service.spec.ts

  ✓ src/agent-gateway/parsers/codex/tests/codex-parse-chat.service.spec.ts (53 tests) 38ms

 Test Files  1 passed (1)
      Tests  53 passed (53)
   Start at  13:08:15
   Duration  869ms (transform 227ms, setup 86ms, import 648ms, tests 39ms, environment 0ms)
```

We also ran the metric-kind-registry spec to verify registry constraints:
```bash
$ bun run test:unit src/telemetry/tests/metric-kind-registry.spec.ts

 ✓ src/telemetry/tests/metric-kind-registry.spec.ts (3 tests) 61ms

 Test Files  1 passed (1)
      Tests  3 passed (3)
```

---

## 4. Key Architectural Decisions Checked

- **Drop, Not Alarm:** We chose to drop and increment a counter (`agent_gateway_parser_reattach_dropped_total`), rather than throw a `PARSE_FAILED` error. Throwing would crash the parsing state for a benign/expected event (abort/reattach flow), causing unnecessary alert storms.
- **Gate on `lastEmittedTurnId` Only:** The guard specifically targets turns that were actually emitted as records. Turns that flushed but were dropped (e.g. synthetic or empty turns) do not set `lastEmittedTurnId`, which is by design since there is no existing record at risk of overwrite.
- **Accumuator Version Unchanged:** Persisted state schema remains at `ACCUMULATOR_VERSION = 2`. The guard relies purely on existing fields, requiring no schema version bump or migration.
