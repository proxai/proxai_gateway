# Phase 4 Walkthrough — Token Shrink Guard Implementation

## 1. Overview
In Phase 4 of the Token Remediation plan, we implemented the **Token Shrink Guard** in the shared batch upsert service. The guard prevents a watermark-advancing write (re-emit) carrying a strictly smaller token total from overwriting an already-finalized fuller turn in the database, which would otherwise corrupt the usage stats and content columns (~30 gated columns).

This implementation provides **defense-in-depth** protection. The main live trigger for this corruption is the Codex `task_started` re-attach pattern, where a post-flush capture re-opens and re-finalizes the same deterministic turn ID with a smaller, partial window.

---

## 2. Changes Implemented

### 2.1 shared batch upsert SQL WHERE update
We modified the DO UPDATE SET `WHERE` clause in [parse-batch-upsert.service.ts](file:///Users/onurseckinsenoglu/.gemini/antigravity-cli/brain/7a4d638b-dc83-46a3-91cc-83c988d0c830/.system_generated/worktrees/subagent-Phase-4-Developer-self-eb11a63c/src/agent-gateway/parse/services/parse-batch-upsert.service.ts#L580-L602) to include the token-shrink guard.
```sql
      WHERE
        (
          agent_call_records.last_capture_watermark_end IS NULL
          OR (
            EXCLUDED.last_capture_watermark_end IS NOT NULL
            AND EXCLUDED.last_capture_watermark_end > agent_call_records.last_capture_watermark_end
          )
        )
        -- Token shrink-guard (defense-in-depth on top of the watermark gate):
        -- refuse a watermark-advancing UPDATE that would STRICTLY shrink the
        -- turn's (input + output) tokens. NULLs are 0, so an INCOMPLETE / partial
        -- re-attach carrying null usage can't null out a finalized turn, and the
        -- ~30 gated content columns are protected alongside the 4 token columns.
        -- >= (not >) keeps equal-token re-parses — same tokens, fuller content
        -- or advanced lineage — winning. ::bigint avoids int4 overflow on the sum.
        AND (
          COALESCE(EXCLUDED.input_tokens, 0)::bigint
            + COALESCE(EXCLUDED.output_tokens, 0)::bigint
          >= COALESCE(agent_call_records.input_tokens, 0)::bigint
            + COALESCE(agent_call_records.output_tokens, 0)::bigint
        )
```

### 2.2 pre-SELECT status query widening
We widened the pre-SELECT query in [parse-batch-upsert.service.ts](file:///Users/onurseckinsenoglu/.gemini/antigravity-cli/brain/7a4d638b-dc83-46a3-91cc-83c988d0c830/.system_generated/worktrees/subagent-Phase-4-Developer-self-eb11a63c/src/agent-gateway/parse/services/parse-batch-upsert.service.ts#L349-L359) to fetch the existing token usage (`input_tokens`, `output_tokens`) and watermarks:
```typescript
    const priorRows = await tx.$queryRaw<
      Array<{
        id: string;
        status: string;
        input_tokens: number | null;
        output_tokens: number | null;
        last_capture_watermark_end: bigint | null;
      }>
    >`SELECT id, status, input_tokens, output_tokens, last_capture_watermark_end FROM agent_call_records WHERE id IN (${Prisma.join(ids)})`;
```

### 2.3 observability & metric emission
We added an inline loop to detect shrink rejections and emit the `agent_gateway_parse_shrink_rejected_total` metric once per agent per batch. This metric is emitted when a watermark-advancing write is refused strictly due to the token shrink guard:
```typescript
    const shrinkRejectedByAgent = new Map<string, number>();
    for (const row of flat) {
      const prior = priorRowById.get(row.id);
      if (prior === undefined) continue;
      const watermarkAllows =
        prior.last_capture_watermark_end === null ||
        (row.lastCaptureWatermarkEnd !== null &&
          row.lastCaptureWatermarkEnd > prior.last_capture_watermark_end);
      if (!watermarkAllows) continue;
      const excludedTokens = (row.inputTokens ?? 0) + (row.outputTokens ?? 0);
      const existingTokens =
        (prior.input_tokens ?? 0) + (prior.output_tokens ?? 0);
      if (excludedTokens < existingTokens) {
        shrinkRejectedByAgent.set(
          row.agent,
          (shrinkRejectedByAgent.get(row.agent) ?? 0) + 1,
        );
      }
    }
    for (const [agent, count] of shrinkRejectedByAgent) {
      Logger.metric('agent_gateway_parse_shrink_rejected_total', count, {
        agent,
      });
    }
```

### 2.4 metric registration
We registered the new metric in [metric-kind-registry.ts](file:///Users/onurseckinsenoglu/.gemini/antigravity-cli/brain/7a4d638b-dc83-46a3-91cc-83c988d0c830/.system_generated/worktrees/subagent-Phase-4-Developer-self-eb11a63c/src/telemetry/metric-kind-registry.ts#L119-L122):
```typescript
    // Verified: per-batch count of DO UPDATE writes refused by the upsert
    // shrink-guard (watermark advanced but input+output tokens would strictly
    // shrink the stored turn), value = N per agent → counter
    agent_gateway_parse_shrink_rejected_total: 'counter',
```

---

## 3. Verification

### 3.1 Unit Tests Added
We updated and added six new unit tests in [parse-batch-upsert.service.spec.ts](file:///Users/onurseckinsenoglu/.gemini/antigravity-cli/brain/7a4d638b-dc83-46a3-91cc-83c988d0c830/.system_generated/worktrees/subagent-Phase-4-Developer-self-eb11a63c/src/agent-gateway/parse/tests/parse-batch-upsert.service.spec.ts#L638-L855) verifying:
- Invariant check: SQL DO UPDATE WHERE clause contains the COALESCE / shrink guard expressions.
- Wider pre-SELECT: fetches the required token and watermark columns.
- Correct metric emission: Fires on watermark-advancing token shrinks (including null-usage coalesce to 0 re-emits).
- Guard attribution: Does not fire if watermark alone vetoes, or if tokens grow or remain equal.

All **29 unit tests** passed:
```bash
 ✓ src/agent-gateway/parse/tests/parse-batch-upsert.service.spec.ts (29 tests) 29ms
 ✓ src/telemetry/tests/metric-kind-registry.spec.ts (3 tests) 60ms
```

### 3.2 Integration Tests Added
We extended the [acr-seed.fixture.ts](file:///Users/onurseckinsenoglu/.gemini/antigravity-cli/brain/7a4d638b-dc83-46a3-91cc-83c988d0c830/.system_generated/worktrees/subagent-Phase-4-Developer-self-eb11a63c/src/agents/orchestration/tests/fixtures/acr-seed.fixture.ts) helper and added four database integration tests in [parse-batch-upsert-returning-xmax.int-spec.ts](file:///Users/onurseckinsenoglu/.gemini/antigravity-cli/brain/7a4d638b-dc83-46a3-91cc-83c988d0c830/.system_generated/worktrees/subagent-Phase-4-Developer-self-eb11a63c/src/agents/orchestration/tests/parse-batch-upsert-returning-xmax.int-spec.ts#L552-L721) asserting:
- Token shrink is refused; token and content columns are preserved.
- Legitimate larger re-parses grow successfully.
- Equal-token writes update content normally.
- Null-usage re-emits over positive-token rows are refused, preserving original tokens/content.

Tests compile and run correctly, skipping when the Postgres connection is unavailable:
```bash
 ✓ src/agents/orchestration/tests/parse-batch-upsert-returning-xmax.int-spec.ts (17 tests) 507ms
```

---

## 4. Design Decisions & Exclusions
- **Reject over Merge**: Following the plan, we rejected the alternative strategy of merging usage (using SUM or MAX) in SQL. Semantics require that the total billing tokens reflect the true final turn status. Rejecting the shrink preserves the integrity of the completed state, whereas sum/max merges would double-count usage or create corrupted hybrids.
- **Metric-only observability**: We accumulated rejections per agent to avoid looped stdout log lines, which would otherwise degrade performance during high-throughput batches.
