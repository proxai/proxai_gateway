# Phase 3 — Walkthrough Document

This document outlines the implementation and verification details of Phase 3 of the Token Remediation plan. 

## 1. Overview
The goal of Phase 3 is to eliminate the **phantom** `cacheCreationInputTokens` value for Gemini steps. Previously, the gateway mapped the protobuf field `5.9.10` to `cacheCreationInputTokens`. However, analysis has verified that `5.9.10` actually represents the visible output token count (`candidatesTokenCount` visible-slice), which is a sub-slice already included in the total output tokens field `5.9.3` (`outputTokens`). Surfacing this field as cache-creation resulted in double-representing a portion of output tokens. 

The remediation disables this mapping, emitting `null` instead for `cacheCreationInputTokens` (truthfully reflecting that Gemini does not report a cache-creation/cache-write metric), while keeping other token fields completely intact.

---

## 2. Implemented Changes

### 2.1 Product Code Changes
**File:** [step-decode.ts](file:///Users/onurseckinsenoglu/repos/proxai/proxai_gateway/src/sources/gemini/step-decode.ts)
The mapping for `cacheCreationInputTokens` was replaced with a `null` literal and a detailed explanatory comment. Other columns (`inputTokens`, `outputTokens`, `cacheReadInputTokens`) were left untouched.

```diff
     model: modelVal !== null ? String(modelVal) : null,
     inputTokens: promptTokens !== null ? promptTokens + (cachedTokens ?? 0) : null,
     outputTokens: pNum(tree, '5.9.3'),
     cacheReadInputTokens: cachedTokens,
-    cacheCreationInputTokens: pNum(tree, '5.9.10'),
+    // Gemini reports no cache-creation count. Proto 5.9.10 is the visible-output
+    // token slice (candidatesTokenCount visible component) and is already inside
+    // outputTokens (5.9.3 == 5.9.9 thoughts + 5.9.10 visible), so surfacing it as a
+    // cache-write count double-represents output. Emit null — Gemini has no such field.
+    cacheCreationInputTokens: null,
   };
 }
```

### 2.2 Test Code Changes
**File:** [step-decode.test.ts](file:///Users/onurseckinsenoglu/repos/proxai/proxai_gateway/src/sources/gemini/tests/step-decode.test.ts)
1. **Existing Test Update:** The existing test `"decodes token usage, caching, and model from step_payload 5.9 envelope"` was updated to assert that `cacheCreationInputTokens` (and its corresponding row-mapping `cache_creation_input_tokens`) are `null` instead of `80`.
2. **New Dedicated Test:** A new test `"does not populate cacheCreationInputTokens from proto 5.9.10 (a visible-output slice already inside outputTokens)"` was added to verify the mathematical identities and that `cacheCreationInputTokens` resolves to `null` while other columns remain intact.

```diff
   const step = decodeStep(15, payload);
   expect(step.model).toBe('1132');
   expect(step.inputTokens).toBe(25000);
   expect(step.outputTokens).toBe(300);
   expect(step.cacheReadInputTokens).toBe(20000);
-  expect(step.cacheCreationInputTokens).toBe(80);
+  // Gemini has no cache-creation field; proto 5.9.10 is a visible-output slice
+  // already counted in outputTokens, so it is not surfaced here.
+  expect(step.cacheCreationInputTokens).toBeNull();
 
   const row = decodeStepRow(42, 15, 3, payload);
   expect(row.model).toBe('1132');
   expect(row.input_tokens).toBe(25000);
   expect(row.output_tokens).toBe(300);
   expect(row.cache_read_input_tokens).toBe(20000);
-  expect(row.cache_creation_input_tokens).toBe(80);
+  expect(row.cache_creation_input_tokens).toBeNull();
 });
+
+test('does not populate cacheCreationInputTokens from proto 5.9.10 (a visible-output slice already inside outputTokens)', () => {
+  // 5.9.* token envelope: prompt(2)=1000, output(3)=600, cached(5)=4000,
+  // thoughts(9)=250, visible(10)=350. Identity holds: 5.9.3 == 5.9.9 + 5.9.10.
+  const payload = concatBytes([
+    varintField(1, 15),
+    msgField(5, [
+      varintField(3, 2),
+      msgField(9, [
+        varintField(2, 1000),
+        varintField(3, 600),
+        varintField(5, 4000),
+        varintField(9, 250),
+        varintField(10, 350),
+      ]),
+    ]),
+  ]);
+
+  const step = decodeStep(15, payload);
+  expect(step.inputTokens).toBe(5000); // 5.9.2(1000) + 5.9.5(4000)
+  expect(step.outputTokens).toBe(600); // 5.9.3, untouched (still includes thoughts)
+  expect(step.cacheReadInputTokens).toBe(4000); // 5.9.5, untouched
+  expect(step.cacheCreationInputTokens).toBeNull(); // 5.9.10 is NOT cache creation
+
+  const row = decodeStepRow(7, 15, 3, payload);
+  expect(row.input_tokens).toBe(5000);
+  expect(row.output_tokens).toBe(600);
+  expect(row.cache_read_input_tokens).toBe(4000);
+  expect(row.cache_creation_input_tokens).toBeNull();
+});
```

---

## 3. Verification and Testing

### 3.1 Typecheck
`bun run typecheck` completed successfully with no TypeScript compilation errors:
```bash
$ bun run typecheck
$ tsc --noEmit
```

### 3.2 Unit Tests
Unit tests in `step-decode.test.ts` and `collect.test.ts` pass cleanly:
```bash
$ bun test src/sources/gemini/tests/step-decode.test.ts src/sources/gemini/tests/collect.test.ts
bun test v1.3.14 (0d9b296a)

src/sources/gemini/tests/step-decode.test.ts:
(pass) decodes a user message step (step_type 14) [4.85ms]
(pass) decodes a run_command tool step (step_type 21) [0.28ms]
(pass) decodes a system [Message] step (step_type 101) [0.18ms]
(pass) decodes an assistant envelope step with thinking text and wrapped tool (step_type 15) [0.10ms]
(pass) decodeStepRow maps a decoded step into the wire-contract row shape [0.32ms]
(pass) decodes an assistant final-text step (step_type 23) [0.10ms]
(pass) decodes a nested tool-result text step (step_type 132) [0.04ms]
(pass) decodes a system summary step (step_type 90) [0.03ms]
(pass) decodes a system memory step (step_type 98) [0.39ms]
(pass) decodes a deeply nested tool result step (step_type 31) [0.04ms]
(pass) decodes a tool step with fallback text path (step_type 25) [0.05ms]
(pass) extracts a string session id from the kv envelope [0.06ms]
(pass) falls back to a numeric session id when the kv value is a varint [0.10ms]
(pass) yields a null session id when the kv envelope value field is absent [0.04ms]
(pass) yields a null session id when the kv value is neither a string nor a varint [0.06ms]
(pass) decodeStep is total over arbitrary bytes [0.11ms]
(pass) decodeTrajectoryMetaRow passes columns through to the row object [0.74ms]
(pass) decodeTrajectoryMetadataBlobRow extracts workspace path and git remote [0.07ms]
(pass) decodeTrajectoryMetadataBlobRow yields null fields when absent [0.02ms]
(pass) decodes token usage, caching, and model from step_payload 5.9 envelope [0.12ms]
(pass) does not populate cacheCreationInputTokens from proto 5.9.10 (a visible-output slice already inside outputTokens) [0.08ms]

src/sources/gemini/tests/collect.test.ts:
(pass) captures all three tables and emits decoded plaintext step rows [18.05ms]
(pass) emits trajectory_meta and trajectory_metadata_blob rows per the wire contract [6.72ms]
(pass) advances the steps watermark and is idempotent on a second poll [8.56ms]
(pass) redacts secrets in decoded user text before emitting (decode-before-redact) [7.11ms]
(pass) records a per-table error and bumps that table cursor when one table read throws [5.94ms]
(pass) bumps consecutive_errors when the source database is corrupt [2.60ms]
(pass) vacuum convergence and advance tests [83.69ms]

 28 pass
 0 fail
 94 expect() calls
Ran 28 tests across 2 files. [260.00ms]
```

### 3.3 Lint
`bun run lint` successfully passed without warnings or errors:
```bash
$ bun run lint
$ oxlint --deny-warnings
Found 0 warnings and 0 errors.
Finished in 66ms on 723 files with 122 rules using 10 threads.
```

---

## 4. Self-Audit results

### 4.1 Proto Path Mapping Audit
We verified that the mapping to the `'5.9.10'` proto path is entirely gone from product source code.

```bash
$ grep -rn "pNum(tree, '5\.9\.10')" src/
# Result: (empty)

$ grep -rn "'5\.9\.10'" src/
# Result: (empty)
```

### 4.2 Property Usage Audit in Gateway
We verified that `cacheCreationInputTokens` or `cache_creation_input_tokens` are not used in any additive operations inside `proxai_gateway` (excluding tests). They are only declared, preserved in the redaction key allow-list, and mapped through as `null`.

```bash
$ grep -rn "cache_creation_input_tokens\|cacheCreationInputTokens" src/ | grep -iv "test"
src/sources/gemini/gemini.types.ts:57:  cacheCreationInputTokens: number | null;
src/sources/gemini/gemini.types.ts:75:  cache_creation_input_tokens: number | null;
src/sources/gemini/step-decode.ts:48:    cacheCreationInputTokens: null,
src/sources/gemini/step-decode.ts:74:    cache_creation_input_tokens: step.cacheCreationInputTokens,
src/services/redaction/preserve.ts:81:  'cache_creation_input_tokens',
```

### 4.3 Property Usage Audit in Nest
We verified that `proxai_nest` does not perform any incorrect aggregations adding cache-creation tokens to output or input totals. Nest correctly computes the turn-level value via a standard pass-through `?? 0` sum, which cleanly evaluates to `0` now that the gateway returns `null`.

```bash
$ grep -rn "cache_creation_input_tokens" src/agent-gateway/parsers/gemini | grep -iv "test"
src/agent-gateway/parsers/gemini/gemini.utils.ts:69:  cache_creation_input_tokens: number | null;
src/agent-gateway/parsers/gemini/gemini.utils.ts:148:      cache_creation_input_tokens: asNumber(raw.cache_creation_input_tokens),
src/agent-gateway/parsers/gemini/gemini.utils.ts:400:  cache_creation_input_tokens: number | null;
src/agent-gateway/parsers/gemini/gemini.utils.ts:419:      cacheCreate += step.cache_creation_input_tokens ?? 0;
src/agent-gateway/parsers/gemini/gemini.utils.ts:428:      cache_creation_input_tokens: null,
src/agent-gateway/parsers/gemini/gemini.utils.ts:436:    cache_creation_input_tokens: cacheCreate,
src/agent-gateway/parsers/gemini/extractors/usage.ts:54:  field: 'result.usage.cache_creation_input_tokens',
src/agent-gateway/parsers/gemini/extractors/usage.ts:56:  extract: pick((u) => u.cache_creation_input_tokens),
src/agent-gateway/parsers/gemini/services/gemini-finalize-turn.service.ts:233:        cache_creation_input_tokens: getValue<number>(
src/agent-gateway/parsers/gemini/services/gemini-finalize-turn.service.ts:234:          'result.usage.cache_creation_input_tokens',
```

---

## 5. Architectural Decisions Checklist

- [x] **Null Emitter:** `cacheCreationInputTokens` for Gemini resolves strictly to `null` (not `0`), reflecting that the metric is absent rather than zero.
- [x] **No Collateral Damage:** `inputTokens` (`5.9.2` + `5.9.5`), `outputTokens` (`5.9.3`), and `cacheReadInputTokens` (`5.9.5`) are kept exactly as they were.
- [x] **No Git Operations:** Checked out modifications are left untracked/unstaged in the working directory as requested.
- [x] **No Nest Code Changes:** No code files in `proxai_nest` were modified.
- [x] **No Schema Changes / Reasoning Field (3b):** As decided in the roadmap, Phase 3b (adding a separate reasoning token field) was skipped.
- [x] **Zero Suppressions / Any:** No lint-suppressions (`@ts-ignore`, etc.) or `any` casts/declarations were added.
