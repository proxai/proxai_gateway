# Phase 1 Walkthrough — Claude Code Token Remediation

This walkthrough details the verification and implementation steps for Phase 1 of the Token Remediation plan. 

---

## 1. Files Changed

### `proxai_gateway`
* `src/sources/claude-code/collect.ts`: Extended the `ClaudeRecord` interface to support `usage`. Added `isUsageBearingAssistantRecord` predicate and updated the kept filter in `collectClaudeCodeFile` to OR the two predicates.
* `src/sources/claude-code/tests/synthetic-filter.test.ts`: Added unit tests for `isUsageBearingAssistantRecord`.
* `src/sources/claude-code/tests/collect.test.ts`: Added an end-to-end integration test asserting that `tool_use`-bearing records carrying usage survive to the decompressed body batch.

### `proxai_nest`
* `src/agent-gateway/parsers/claude-code/extractors/usage.ts`: Updated `inputTokensExtractor` to fold `cache_creation_input_tokens` into `input_tokens` (fresh input tokens logic).
* `src/agent-gateway/parsers/claude-code/extractors/tests/usage.spec.ts`: Updated existing roll-up assertion and added a new unit test for cache creation fold and subset invariant.

---

## 2. Source Diffs

### `proxai_gateway`: `collect.ts`
```diff
diff --git a/src/sources/claude-code/collect.ts b/src/sources/claude-code/collect.ts
index 3f2424b..a70d13d 100644
--- a/src/sources/claude-code/collect.ts
+++ b/src/sources/claude-code/collect.ts
@@ -122,7 +122,12 @@ interface ClaudeRecord {
   type?: unknown;
   isMeta?: unknown;
   isApiErrorMessage?: unknown;
-  message?: { content?: ClaudeContent; text?: unknown; model?: unknown };
+  message?: {
+    content?: ClaudeContent;
+    text?: unknown;
+    model?: unknown;
+    usage?: unknown;
+  };
   content?: ClaudeContent;
   text?: unknown;
 }
@@ -202,6 +207,44 @@ export function isDialogueRecord(parsed: unknown): boolean {
   return !hasToolUse;
 }
 
+/**
+ * Telemetry-preservation predicate (split out from the display filter).
+ *
+ * `isDialogueRecord` is a DISPLAY filter: it drops every assistant record that
+ * carries a `tool_use` block, which also discards that record's per-call
+ * `usage`. In an agentic loop those intermediate tool-calling API calls are
+ * separately billed by Anthropic and carry the bulk of the turn's cache/output
+ * tokens, so dropping them makes the backend's `aggregateUsage` sum only the
+ * final text record. This predicate keeps the telemetry: it returns true for a
+ * real (non-meta, non-synthetic, non-api-error) assistant record that carries a
+ * `usage` block. The upload filter ORs the two predicates, so each line is
+ * evaluated once and kept at most once — display filtering and telemetry
+ * preservation are separate concerns by design.
+ */
+export function isUsageBearingAssistantRecord(parsed: unknown): boolean {
+  if (parsed === null || typeof parsed !== 'object') {
+    return false;
+  }
+  const record = parsed as ClaudeRecord;
+  if (record.type !== 'assistant') {
+    return false;
+  }
+  if (record.isMeta === true) {
+    return false;
+  }
+  // Synthetic-model and api-error records are not real billable model calls —
+  // keep them dropped, exactly as the display filter does.
+  if (
+    record.message?.model === '<synthetic>' ||
+    record.isApiErrorMessage === true
+  ) {
+    return false;
+  }
+  const usage = record.message?.usage;
+  return usage !== null && typeof usage === 'object';
+}
+
+
 export async function collectClaudeCodeFile(
   file: DiscoveredClaudeCodeFile,
   context: ClaudeCodeCollectorContext,
@@ -248,7 +291,7 @@ export async function collectClaudeCodeFile(
       if (line.trim().length > 0) {
         try {
           const parsed = JSON.parse(line);
-          if (isDialogueRecord(parsed)) {
+          if (isDialogueRecord(parsed) || isUsageBearingAssistantRecord(parsed)) {
             kept.push({
               text: line,
               physicalEndOffset: lineEndOffset,
```

### `proxai_nest`: `usage.ts`
```diff
diff --git a/src/agent-gateway/parsers/claude-code/extractors/usage.ts b/src/agent-gateway/parsers/claude-code/extractors/usage.ts
index fa0cfdb2..809788a4 100644
--- a/src/agent-gateway/parsers/claude-code/extractors/usage.ts
+++ b/src/agent-gateway/parsers/claude-code/extractors/usage.ts
@@ -48,7 +48,17 @@ function pickNumber(
 export const inputTokensExtractor: FieldExtractor<number> = {
   field: 'result.usage.input_tokens',
   supports: '>=2.0.0 <3.0.0',
-  extract: pickNumber((u) => u.input_tokens),
+  // Store inputTokens as FRESH INPUT = raw input_tokens + cache_creation_input_tokens.
+  // Tokens written to the prompt cache are billed at ~full rate, so they belong in
+  // "fresh input"; this makes Claude's inputTokens directly comparable to Gemini/Codex.
+  // The raw cache-write count is preserved separately by cacheCreationInputTokensExtractor
+  // (a non-additive subset of this value — never add it into a grand total). Null only
+  // when the turn carried no usage block at all (input_tokens === null).
+  extract: pickNumber((u) =>
+    u.input_tokens === null
+      ? null
+      : u.input_tokens + (u.cache_creation_input_tokens ?? 0),
+  ),
 };
 
 export const outputTokensExtractor: FieldExtractor<number> = {
```

---

## 3. Test Results

### `proxai_gateway`

#### Typecheck
```bash
$ bun run typecheck
$ tsc --noEmit
```
Status: **Passed**

#### `collect.test.ts`
```bash
$ bun test src/sources/claude-code/tests/collect.test.ts
bun test v1.3.14 (0d9b296a)

src/sources/claude-code/tests/collect.test.ts:
...
(pass) uploads usage-bearing tool_use assistant records so the full agentic loop reaches the backend [3.03ms]

 44 pass
 0 fail
Ran 44 tests across 1 file. [268.00ms]
```

#### `synthetic-filter.test.ts`
```bash
$ bun test src/sources/claude-code/tests/synthetic-filter.test.ts
bun test v1.3.14 (0d9b296a)

src/sources/claude-code/tests/synthetic-filter.test.ts:
(pass) isDialogueRecord: drops isMeta user records [0.63ms]
(pass) isDialogueRecord: drops synthetic shell and command wrapper text [0.13ms]
(pass) isDialogueRecord: keeps a genuine user prompt [0.03ms]
(pass) isDialogueRecord: drops synthetic-model and api-error assistant records [0.04ms]
(pass) isDialogueRecord: keeps assistant text even with non-text items in the array [0.03ms]
(pass) isUsageBearingAssistantRecord: keeps tool_use assistant records carrying usage [0.03ms]
(pass) isUsageBearingAssistantRecord: drops assistant records with no usage block [0.01ms]
(pass) isUsageBearingAssistantRecord: drops synthetic, api-error, and meta records even with usage [0.02ms]
(pass) isUsageBearingAssistantRecord: drops non-assistant and non-object inputs [0.01ms]

 9 pass
 0 fail
Ran 9 tests across 1 file. [37.00ms]
```

#### Linter
```bash
$ bun run lint
$ oxlint --deny-warnings
Found 0 warnings and 0 errors.
```

---

### `proxai_nest`

#### Typecheck
```bash
$ bun run typecheck
$ tsc --noEmit
```
Status: **Passed**

#### `usage.spec.ts` unit tests
```bash
$ bun run test:unit src/agent-gateway/parsers/claude-code/extractors/tests/usage.spec.ts
$ vitest run src/agent-gateway/parsers/claude-code/extractors/tests/usage.spec.ts

 RUN  v4.1.6 /Users/onurseckinsenoglu/repos/proxai/proxai_nest

 ✓ src/agent-gateway/parsers/claude-code/extractors/tests/usage.spec.ts (5 tests) 3ms

 Test Files  1 passed (1)
      Tests  5 passed (5)
```

#### Full `claude-code` parser spec suite
```bash
$ bun run test:unit src/agent-gateway/parsers/claude-code/
...
 Test Files  14 passed (14)
      Tests  189 passed (189)
```

---

## 4. Audit-Grep Results

The audit grep query:
```bash
grep -rn "cacheCreationInputTokens\|cache_creation_input_tokens" src/ | grep -iv "test\|spec"
```
Successfully confirmed that `cache_creation_input_tokens` / `cacheCreationInputTokens` appears only where it is written, mapped, or aggregated as its own standalone column. It is **never** added to any grand total (which would result in double-counting after folding it into `inputTokens`).

---

## 5. Type and Suppression Compliance
* **`any` uses**: None. All code written uses strict types (`unknown` and type guards where needed).
* **Suppression comments**: None. No `@ts-ignore`, `@ts-expect-error`, etc.
* **Link / Build checks**: Passed. Build scripts for both repositories ran successfully.

---

## 6. Out-of-Scope Confirmations
Confirmed that none of the following out-of-scope files/structures were modified:
* `isDialogueRecord` (display filter)
* `claude-desktop/`
* `poll-worker.ts`
* `aggregateUsage` (remains a pure sum)
* `build-scalar-spine.ts` (agent-agnostic spine)
* `claude-code-finalize-turn.service.ts`
* Any database schemas or migrations.

---

## 7. Acceptance Criteria Verification

* [x] `tool_use`-bearing assistant records' `usage` reaches the backend (verified via `collect.test.ts` body test).
* [x] Backend `aggregateUsage` sums the full loop correctly once they arrive.
* [x] No regressions for text-only turns; each line kept exactly once.
* [x] `inputTokens` = raw `input_tokens` + `cache_creation_input_tokens`.
* [x] `cacheCreationInputTokens` preserved as raw column (not nulled).
* [x] Tests assert the fold, the invariant `0 ≤ cacheCreationInputTokens ≤ inputTokens`, and audit confirms no total adds `cacheCreationInputTokens`.
* [x] All new and updated tests pass; `typecheck` and `lint` compile cleanly.
