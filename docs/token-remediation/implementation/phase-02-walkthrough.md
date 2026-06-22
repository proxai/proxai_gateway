# Phase 2 Walkthrough — Codex Token Over-Counting Remediation

This walkthrough details the verification and implementation steps for Phase 2 of the Token Remediation plan (Codex Over-counting Fix).

---

## 1. Files Changed

### `proxai_nest`
* `src/agent-gateway/parsers/codex/codex.utils.ts`:
  * Added `readTurnEndCumulative` to resolve the final `total_token_usage` of a turn.
  * Extracted the old delta-sum logic into `aggregateUsageByLastTokenSum` to act as a fallback for older rollout schemas.
  * Rewrote `aggregateUsage` to compute turn token usages as cumulative difference (`end - start`), clamping at zero and calculating non-cached `input_tokens`.
* `src/agent-gateway/parsers/codex/services/codex-finalize-turn.service.ts`:
  * Threaded optional `priorCumulativeUsage` into `FinalizeTurnParams` and `buildScratch`.
  * Passed this anchor to `aggregateUsage`.
  * Updated comments under `result.usage` to reflect current behavior.
* `src/agent-gateway/parsers/codex/services/codex-parse-chat.service.ts`:
  * Added the additive `priorCumulativeUsage` field to `CodexAccumulator` without bumping the accumulator version.
  * Passed `acc.priorCumulativeUsage` down into `finalizeTurn`.
  * Advanced `acc.priorCumulativeUsage` using `readTurnEndCumulative(openLines)` right after finalization, ensuring even dropped/empty turns correctly anchor subsequent turns.
* `src/agent-gateway/parsers/codex/extractors/usage.ts`:
  * Rewrote the stale docstring.
  * Updated the `getUsage` fallback to pass `null` as the prior cumulative usage.
* `src/agent-gateway/parsers/codex/tests/codex.utils.spec.ts`:
  * Replaced the old delta-sum test with six new unit cases (A–F) covering all required edge cases.
  * Applied compilation and value fixes to existing tests that changed under the new diff semantics (such as renaming and asserting the `999` value for the no-last-usage scenario, updating non-event skips to assert `80`, and fixing missing argument issues).
* `src/agent-gateway/parsers/codex/tests/codex-parse-chat.service.spec.ts`:
  * Added the `turnLinesWithTotal` helper.
  * Added the parse-chat-level integration test case asserting correct thread-anchored token difference and re-emission cancellation across multiple turns.

---

## 2. Source Diffs

### `proxai_nest`: `codex.utils.ts`
```diff
diff --git a/src/agent-gateway/parsers/codex/codex.utils.ts b/src/agent-gateway/parsers/codex/codex.utils.ts
index c6b965f..df39d48 100644
--- a/src/agent-gateway/parsers/codex/codex.utils.ts
+++ b/src/agent-gateway/parsers/codex/codex.utils.ts
@@ -308,54 +308,124 @@ export function lineTurnId(line: CodexLine): string | null {
 // Per-turn aggregations
 // ─────────────────────────────────────────────────────────────────────────
 
-/**
- * Aggregate token usage across all `token_count` events in the turn.
- *
- * Empirical reality (verified 2026-05-12 against 5 high-output native
- * rollouts): Codex emits `last_token_usage` per `token_count` event as a
- * per-emit DELTA, not a per-turn cumulative snapshot. The prior code kept
- * only the last event's snapshot, which capped `output_tokens` at ~2,344
- * across all DB rows (one delta's worth) instead of the real per-turn
- * total (~50K on long replies). Sum across events for output.
- *
- * For `input_tokens` / `cached_input_tokens` / `reasoning_output_tokens`:
- * empirical pattern is the same delta semantics — sum across events.
- * If a future Codex schema flips to cumulative snapshots, the sum
- * over-counts and we'd flip back to "take last." Caught by the unit
- * spec on multi-event fixtures.
- *
- * Note: `input_tokens` represents non-cached input tokens, calculated by
- * subtracting `cached_input_tokens` from `input_tokens` for each delta
- * to align with the gateway non-cached token model.
- */
-export function aggregateUsage(lines: CodexLine[]): {
-  input_tokens: number | null;
-  output_tokens: number | null;
-  cache_read_input_tokens: number | null;
-  cache_creation_input_tokens: number | null;
-  reasoning_output_tokens: number | null;
-} {
-  let inputSum: number | null = null;
-  let outputSum: number | null = null;
-  let cachedSum: number | null = null;
-  let reasoningSum: number | null = null;
-  let sawAny = false;
-  const addTo = (current: number | null, delta: number | undefined) => {
-    if (typeof delta !== 'number' || !Number.isFinite(delta)) return current;
-    return (current ?? 0) + delta;
-  };
-  for (const line of lines) {
-    if (line.type !== 'event_msg') continue;
-    const p = line.payload as {
-      type?: string;
-      info?: { last_token_usage?: TokenUsageBlock };
-    };
-    if (p.type !== 'token_count' || !p.info?.last_token_usage) continue;
-    const usage = p.info.last_token_usage;
-    sawAny = true;
-    const nonCachedInput =
-      usage.input_tokens !== undefined &&
-      usage.cached_input_tokens !== undefined
-        ? Math.max(0, usage.input_tokens - usage.cached_input_tokens)
-        : usage.input_tokens;
-    inputSum = addTo(inputSum, nonCachedInput);
-    outputSum = addTo(outputSum, usage.output_tokens);
-    cachedSum = addTo(cachedSum, usage.cached_input_tokens);
-    reasoningSum = addTo(reasoningSum, usage.reasoning_output_tokens);
-  }
-  if (!sawAny) {
-    return {
-      input_tokens: null,
-      output_tokens: null,
-      cache_read_input_tokens: null,
-      cache_creation_input_tokens: null,
-      reasoning_output_tokens: null,
-    };
-  }
-  return {
-    input_tokens: inputSum,
-    output_tokens: outputSum,
-    cache_read_input_tokens: cachedSum,
-    // Codex doesn't distinguish "creation" the way Anthropic does — all
-    // cached tokens are reads. Leave creation null (declared-but-absent).
-    cache_creation_input_tokens: null,
-    reasoning_output_tokens: reasoningSum,
-  };
-}
+/**
+ * The cumulative session total at the END of this turn: the `total_token_usage`
+ * of the LAST `token_count` event in the turn that carries one. `total_token_usage`
+ * is monotonic and re-emitted frames repeat it, so the last one is the turn's true
+ * endpoint. Returns null when no event in the turn carried a `total_token_usage`
+ * block (older Codex schema) — callers fall back to the legacy delta sum.
+ */
+export function readTurnEndCumulative(
+  lines: CodexLine[],
+): TokenUsageBlock | null {
+  let end: TokenUsageBlock | null = null;
+  for (const line of lines) {
+    if (line.type !== 'event_msg') continue;
+    const p = line.payload as {
+      type?: string;
+      info?: { total_token_usage?: TokenUsageBlock };
+    };
+    if (p.type !== 'token_count') continue;
+    if (p.info?.total_token_usage) end = p.info.total_token_usage;
+  }
+  return end;
+}
+
+// Legacy per-emit delta sum of `last_token_usage`. Used only when NO token_count
+// event in the turn carried a `total_token_usage` block (older Codex schema), where
+// the cumulative-diff path can't run. Same shape it always produced.
+function aggregateUsageByLastTokenSum(lines: CodexLine[]): {
+  input_tokens: number | null;
+  output_tokens: number | null;
+  cache_read_input_tokens: number | null;
+  cache_creation_input_tokens: number | null;
+  reasoning_output_tokens: number | null;
+} {
+  let inputSum: number | null = null;
+  let outputSum: number | null = null;
+  let cachedSum: number | null = null;
+  let reasoningSum: number | null = null;
+  let sawAny = false;
+  const addTo = (current: number | null, delta: number | undefined) => {
+    if (typeof delta !== 'number' || !Number.isFinite(delta)) return current;
+    return (current ?? 0) + delta;
+  };
+  for (const line of lines) {
+    if (line.type !== 'event_msg') continue;
+    const p = line.payload as {
+      type?: string;
+      info?: { last_token_usage?: TokenUsageBlock };
+    };
+    if (p.type !== 'token_count' || !p.info?.last_token_usage) continue;
+    const usage = p.info.last_token_usage;
+    sawAny = true;
+    const nonCachedInput =
+      usage.input_tokens !== undefined &&
+      usage.cached_input_tokens !== undefined
+        ? Math.max(0, usage.input_tokens - usage.cached_input_tokens)
+        : usage.input_tokens;
+    inputSum = addTo(inputSum, nonCachedInput);
+    outputSum = addTo(outputSum, usage.output_tokens);
+    cachedSum = addTo(cachedSum, usage.cached_input_tokens);
+    reasoningSum = addTo(reasoningSum, usage.reasoning_output_tokens);
+  }
+  if (!sawAny) {
+    return {
+      input_tokens: null,
+      output_tokens: null,
+      cache_read_input_tokens: null,
+      cache_creation_input_tokens: null,
+      reasoning_output_tokens: null,
+    };
+  }
+  return {
+    input_tokens: inputSum,
+    output_tokens: outputSum,
+    cache_read_input_tokens: cachedSum,
+    // Codex doesn't distinguish "creation" the way Anthropic does — all
+    // cached tokens are reads. Leave creation null (declared-but-absent).
+    cache_creation_input_tokens: null,
+    reasoning_output_tokens: reasoningSum,
+  };
+}
+
+/**
+ * Per-turn token usage = the cumulative-total DIFFERENCE across the turn:
+ *   field = max(0, total_token_usage(turn end) − priorCumulative(turn start))
+ *
+ * `total_token_usage` is the running session total (monotonic). The turn's end is
+ * the last `token_count` event's total; the start anchor is the prior turn's final
+ * total (carried across ticks in the parse accumulator, null for the first turn).
+ * Codex re-emits `token_count` frames at turn boundaries and on rate-limit-only
+ * updates; because those frames repeat the cumulative total, the difference excludes
+ * them automatically — fixing the historical over-count from summing `last_token_usage`.
+ *
+ * `input_tokens` is returned NON-CACHED (OpenAI's `input_tokens` includes the cached
+ * half): non-cached = inputDiff − cachedDiff; `cache_read_input_tokens` = cachedDiff.
+ *
+ * Fallback: if no event carried `total_token_usage`, defer to the legacy
+ * `last_token_usage` delta sum so older schemas keep parsing.
+ */
+export function aggregateUsage(
+  lines: CodexLine[],
+  priorCumulative: TokenUsageBlock | null,
+): {
+  input_tokens: number | null;
+  output_tokens: number | null;
+  cache_read_input_tokens: number | null;
+  cache_creation_input_tokens: number | null;
+  reasoning_output_tokens: number | null;
+} {
+  const end = readTurnEndCumulative(lines);
+  if (end === null) {
+    return aggregateUsageByLastTokenSum(lines);
+  }
+
+  const start = priorCumulative ?? {};
+  const diff = (e: number | undefined, s: number | undefined): number =>
+    Math.max(0, (e ?? 0) - (s ?? 0));
+
+  const inputDiff = diff(end.input_tokens, start.input_tokens);
+  const cachedDiff = diff(end.cached_input_tokens, start.cached_input_tokens);
+  const outputDiff = diff(end.output_tokens, start.output_tokens);
+  const reasoningDiff = diff(
+    end.reasoning_output_tokens,
+    start.reasoning_output_tokens,
+  );
+
+  return {
+    input_tokens: Math.max(0, inputDiff - cachedDiff), // non-cached
+    output_tokens: outputDiff,
+    cache_read_input_tokens: cachedDiff,
+    cache_creation_input_tokens: null, // Codex has no cache-write counter
+    reasoning_output_tokens: reasoningDiff,
+  };
+}
```

### `proxai_nest`: `codex-finalize-turn.service.ts`
```diff
diff --git a/src/agent-gateway/parsers/codex/services/codex-finalize-turn.service.ts b/src/agent-gateway/parsers/codex/services/codex-finalize-turn.service.ts
index d7a1490..e982181 100644
--- a/src/agent-gateway/parsers/codex/services/codex-finalize-turn.service.ts
+++ b/src/agent-gateway/parsers/codex/services/codex-finalize-turn.service.ts
@@ -36,6 +36,7 @@ import {
   type SessionMetaPayload,
   type TaskCompletePayload,
   type TurnContextPayload,
+  type TokenUsageBlock,
   aggregateUsage,
   isHeartbeatUserPromptText,
   linesToMessageContent,
@@ -73,6 +74,13 @@ interface FinalizeTurnParams {
    * agent_metadata.turn_context. Pre-0.128 sessions don't emit this envelope; null is normal.
    */
   turnContext?: TurnContextPayload | null;
+  /**
+   * The prior turn's final cumulative `total_token_usage`, carried across ticks
+   * by the parse accumulator. Null for the first turn of a session, and absent
+   * when a caller supplies no anchor. Used by aggregateUsage to compute this
+   * turn's tokens as a cumulative difference.
+   */
+  priorCumulativeUsage?: TokenUsageBlock | null;
 }
 
 function buildScratch(
@@ -82,8 +90,9 @@ function buildScratch(
   turnContext: TurnContextPayload | null,
   turnId: string,
   parentTurnId: string | null,
+  priorCumulativeUsage: TokenUsageBlock | null,
 ): Record<string, unknown> {
-  const usage = aggregateUsage(lines);
+  const usage = aggregateUsage(lines, priorCumulativeUsage);
   let droppedBlocks = 0;
   const resultContent: MessageContent[] = linesToMessageContent(lines, () => {
     droppedBlocks++;
@@ -127,6 +136,7 @@ export function finalizeTurn(
     params.turnContext ?? null,
     turnId,
     parentTurnId,
+    params.priorCumulativeUsage ?? null,
   );
   const ctx: ExtractContext = {
     agent: 'CODEX',
@@ -305,10 +315,9 @@ export function finalizeTurn(
       usage: {
         input_tokens: getValue<number>('result.usage.input_tokens'),
         output_tokens: getValue<number>('result.usage.output_tokens'),
-        // A3: defaults false; A2 (cross-turn accumulator delta path)
-        // will flip this to true when tokens are synthesized from prior-
-        // turn cumulative anchor. Until A2 lands, only the authoritative
-        // path (last_token_usage) runs; flag stays false.
+        // Codex tokens are derived by differencing the cumulative `total_token_usage`
+        // across the turn (exact arithmetic on the reported running totals), so they are
+        // authoritative, not estimated.
         tokens_are_estimated: false,
         cache_creation_input_tokens: getValue<number>(
           'result.usage.cache_creation_input_tokens',
@@ -317,11 +326,8 @@ export function finalizeTurn(
           'result.usage.cache_read_input_tokens',
         ),
         service_tier: null,
-        // Deferred per v6 plan §A2 — Codex emits a `token_count` event
-        // per turn carrying total_token_usage, but accurately deriving
-        // a per-turn delta vs a session cumulative requires accumulator-
-        // persisted prior-turn anchors (cross-turn token recovery). Stays
-        // null until A2 lands.
+        // The session cumulative total is tracked in the parse accumulator to difference
+        // each turn; it is not surfaced as its own column today.
         thread_cumulative_tokens: null,
       },
       timestamp: {
```

### `proxai_nest`: `codex-parse-chat.service.ts`
```diff
diff --git a/src/agent-gateway/parsers/codex/services/codex-parse-chat.service.ts b/src/agent-gateway/parsers/codex/services/codex-parse-chat.service.ts
index c7cc3ea..a9ee4be 100644
--- a/src/agent-gateway/parsers/codex/services/codex-parse-chat.service.ts
+++ b/src/agent-gateway/parsers/codex/services/codex-parse-chat.service.ts
@@ -64,9 +64,11 @@ import { S3GetService } from '../../../s3/services/s3-get.service';
 import {
   type CodexLine,
   type SessionMetaPayload,
+  type TokenUsageBlock,
   eventMsgType,
   isSessionMeta,
   isTurnContext,
   type TurnContextPayload,
   lineTurnId,
   parseCodexLine,
+  readTurnEndCumulative,
 } from '../codex.utils';
@@ -89,6 +91,11 @@ interface CodexAccumulator {
   openCaptureLastId: string | null;
   openCaptureLastWatermarkStr: string | null;
   lastEmittedTurnId: string | null;
+  /**
+   * The prior turn's final cumulative `total_token_usage`. The start anchor for the
+   * next turn's cumulative-difference token computation. Null at session start.
+   */
+  priorCumulativeUsage: TokenUsageBlock | null;
 }
 
 function emptyAccumulator(): CodexAccumulator {
@@ -101,6 +108,7 @@ function emptyAccumulator(): CodexAccumulator {
     openCaptureLastId: null,
     openCaptureLastWatermarkStr: null,
     lastEmittedTurnId: null,
+    priorCumulativeUsage: null,
   };
 }
 
@@ -254,6 +262,7 @@ export class CodexParseChatService {
               openCaptureLastId,
               openCaptureLastWatermark,
               null,
+              acc.priorCumulativeUsage,
               turnContextByTurnId.get(acc.openTurnId) ?? null,
             );
             openLines = [];
@@ -312,6 +321,7 @@ export class CodexParseChatService {
             openCaptureLastId,
             openCaptureLastWatermark,
             null,
+            acc.priorCumulativeUsage,
             turnContextByTurnId.get(acc.openTurnId) ?? null,
           );
           openLines = [];
@@ -346,6 +356,7 @@ export class CodexParseChatService {
         openCaptureLastId,
         openCaptureLastWatermark,
         'idle_timeout',
+        acc.priorCumulativeUsage,
         turnContextByTurnId.get(acc.openTurnId) ?? null,
       );
       openLines = [];
@@ -454,6 +465,7 @@ export class CodexParseChatService {
     openCaptureLastId: string | null,
     openCaptureLastWatermark: bigint | null,
     flushReasonOverride: FlushReason | null,
+    priorCumulativeUsage: TokenUsageBlock | null,
     turnContext: TurnContextPayload | null,
   ): void {
     if (
@@ -487,6 +499,7 @@ export class CodexParseChatService {
       parserVersion,
       metricAccumulator,
       flushReasonOverride,
+      priorCumulativeUsage,
       turnContext,
     });
 
@@ -507,6 +520,14 @@ export class CodexParseChatService {
     // load-bearing job is to suppress `emitted.push` / `lastEmittedTurnId`
     // advance / `writeIdleFlushAuditRow` — observability is owned by the
     // finalize-turn drop site.
+
+    // Advance the session anchor to this turn's final cumulative so the NEXT turn
+    // differences against it. Do this even when `finalized === null` (a dropped/empty
+    // turn still consumed tokens that the cumulative reflects) so the next turn isn't
+    // over-counted. Stays put when this turn carried no total_token_usage (fallback regime).
+    const turnEndCumulative = readTurnEndCumulative(openLines);
+    if (turnEndCumulative !== null) {
+      acc.priorCumulativeUsage = turnEndCumulative;
     }
 
     // Clear the persisted open lineage — next task_started opens fresh.
@@ -633,6 +654,7 @@ export class CodexParseChatService {
         openCaptureLastId: blob.openCaptureLastId ?? null,
         openCaptureLastWatermarkStr: blob.openCaptureLastWatermarkStr ?? null,
         lastEmittedTurnId: blob.lastEmittedTurnId ?? null,
+        priorCumulativeUsage: blob.priorCumulativeUsage ?? null,
       };
     }
```

### `proxai_nest`: `extractors/usage.ts`
```diff
diff --git a/src/agent-gateway/parsers/codex/extractors/usage.ts b/src/agent-gateway/parsers/codex/extractors/usage.ts
index cd7d61c..1a525f0 100644
--- a/src/agent-gateway/parsers/codex/extractors/usage.ts
+++ b/src/agent-gateway/parsers/codex/extractors/usage.ts
@@ -1,9 +1,8 @@
 /**
  * Codex — `result.usage.*` extractors.
  *
- * Codex emits `event_msg.token_count` events with both cumulative
- * (`total_token_usage`) and per-turn (`last_token_usage`) blocks. We use
- * `last_token_usage` from the LATEST `token_count` event in the turn —
- * that's the snapshot taken just before/after `task_complete` and reflects
- * THIS turn's deltas.
+ * Token usage is computed by `aggregateUsage` as the cumulative-total DIFFERENCE
+ * across the turn: `total_token_usage(turn end) − priorCumulative(turn start)`.
+ * The diffed roll-up is precomputed once per turn into `ctx.scratch.usage` by
+ * `buildScratch`; these extractors just read individual fields off it.
  *
- * Cardinality: 4 fields × ~ a few schema-versions × 2 outcomes = small.
+ * `input_tokens` is non-cached (OpenAI input includes cached); `cache_creation`
+ * is always null (Codex emits no cache-write counter).
  */
 
 import {
@@ -24,5 +23,5 @@ function getUsage(ctx: ExtractContext): ReturnType<typeof aggregateUsage> {
     | undefined;
   if (cached) return cached;
   const lines = (ctx.scratch?.lines as CodexLine[] | undefined) ?? [];
-  return aggregateUsage(lines);
+  return aggregateUsage(lines, null);
 }
```

---

## 3. Test Verification Results

### Typecheck
Type checking was performed locally using `tsc --noEmit` via `bun run typecheck` and passes completely:
```bash
$ bun run typecheck
$ tsc --noEmit
```
Status: **Passed**

### Unit Tests
The Vitest suite for Codex was run and passes completely:
```bash
$ bun run test:unit src/agent-gateway/parsers/codex
✓ src/agent-gateway/parsers/codex/tests/codex-parse-chat.service.spec.ts (50 tests) 48ms
...
 Test Files  7 passed (7)
      Tests  303 passed (303)
   Duration  1.24s
```
Status: **Passed**

---

## 4. Updates to Existing Tests

We resolved TypeScript signature compile errors (TypeScript `TS2554: Expected 2 arguments, but got 1`) across existing tests by passing `null` as the prior cumulative usage where appropriate:
1. `returns all-null when no token_count event present`: Compile fix (passed `null`).
2. `returns all-null for empty lines list`: Compile fix (passed `null`).
3. `treats missing token-block fields as null`: Compile fix (passed `null`).
4. `cache_creation_input_tokens is hard-coded null even when cached_input_tokens present`: Compile fix (passed `null`).
5. `returns null for a usage block with input_tokens undefined`: Compile fix (passed `null`).
6. `aggregateUsage ignores session_meta + response_item lines`: Compile fix (passed `null`).
7. `aggregateUsage falls back to null when token block omits individual fields`: Compile fix (passed `null`).

We also updated semantic behavior assertions:
1. `skips token_count events without a last_token_usage block`: Renamed to `derives a turn from total_token_usage even when last_token_usage is absent`, passed `null` as the prior cumulative, and updated assertions to check for `999` (as the diff path now resolves this total against the null anchor).
2. `aggregateUsage skips lines that are not event_msg without throwing`: Added `null` prior cumulative argument and updated `input_tokens` assertion from `65` to `80` (diff of 100 - 20) under the new diffing scheme.
3. `extractors fallback test (usage.spec.ts)`: Passed `null` fallback argument (no value changes since it routes to the legacy delta fallback).

---

## 5. Implementation Decisions & Edge Cases

* **`tokens_are_estimated` stays `false`**: We confirmed that tokens are not treated as estimated because the cumulative difference method performs exact math on Codex's reported monotonically increasing totals.
* **No `ACCUMULATOR_VERSION` bump**: The new `priorCumulativeUsage` field was added as an additive, optional field to prevent invalidating or resetting active/in-flight parser session accumulators.
* **Deploy-Straddling Edge Case**: An active session straddling a deploy starts with a `null` anchor and will transiently calculate its next turn against `0`. This is a bounded, one-time behavior corrected on subsequent turns and handled backward by the Phase 11 re-parse, as documented.
