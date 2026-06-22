# Phase 8 Walkthrough — Cursor Local-Only Collection

This document details the walkthrough of the implementation and test verification of **Phase 8: Cursor Local-Only Collection** under the Token Remediation plan.

---

## 1. Executive Summary

Cursor bills server-side and does not record actual billed tokens in its local desktop database (every bubble's `tokenCount` is `{0, 0}`). Option A was implemented to preserve truthful billing records (`result.usage` columns remain null) while surfacing the context window fill level and productivity stats as a **gauge** inside the `agent_metadata` JSONB bag.

- **The Goal:** Collect and surface Cursor's input context size gauge (`contextTokensUsed` / `contextTokenLimit` / `contextUsagePercent`, prompt category breakdown, and line additions/removals) and the per-turn `contextWindowStatusAtCreation` without introducing incorrect sum-over-time flows or schema migrations.
- **The Solution:** 
  1. Updated `proxai_gateway` to preserve the user bubble's `contextWindowStatusAtCreation` key through the trimming phase.
  2. Updated `proxai_nest` to parse, pin, and surface composer-level context size gauges and per-turn gauges directly in `agent_metadata`.
  3. Ensured that no gauge values ever leak into the billed token columns (`result.usage.input_tokens` remains null) to prevent incorrect summing downstream.

---

## 2. Implementation Details

We modified files in both `proxai_nest` and `proxai_gateway`.

### 2.1 proxai_nest Changes

1. **`src/agent-gateway/parsers/cursor/cursor.utils.ts`**:
   Extended `CursorComposerHeader` and `CursorBubble` interfaces to type the new gauge and code line changes fields safely as optional fields with strict `unknown` (rather than `any`) bounds.
   
2. **`src/agent-gateway/parsers/cursor/services/cursor-parse-chat.service.ts`**:
   Updated `pinComposer` to preserve the context size and productivity gauges in the pinned header. Latest-non-null snapshot wins, ensuring we track compaction (lowered values) rather than a simple monotonic maximum.

3. **`src/agent-gateway/parsers/cursor/services/cursor-finalize-turn.service.ts`**:
   - Extended `PinnedComposerHeader` interface with the optional gauge fields.
   - Extracted `contextWindowStatusAtCreation.tokensUsed` from the user bubble.
   - Updated `buildAgentMetadata` to merge the composer-level and turn-level gauge fields into `agent_metadata` only if they are present and non-null.

### 2.2 proxai_gateway Changes

1. **`src/sources/cursor/process-rows.ts`**:
   Added `contextWindowStatusAtCreation` to `CURSOR_BUBBLE_KEEP_KEYS` list so that per-turn context metrics on user bubbles survive the gateway's SQLite row trimming logic.

---

## 3. Verification & Testing

All verification steps passed successfully across both projects.

### 3.1 proxai_nest Verification

#### 3.1.1 Typecheck
```bash
$ bun run typecheck
$ tsc --noEmit
# Completed successfully with no errors or warnings
```

#### 3.1.2 Unit Tests
We verified the parser service tests, including the new assertions for Option A gauge behaviors (no-sum, latest-wins, billed-null checks, agentKv passthrough safety).

```bash
$ bun run test:unit src/agent-gateway/parsers/cursor/services/tests/cursor-finalize-turn.service.spec.ts

 ✓ src/agent-gateway/parsers/cursor/services/tests/cursor-finalize-turn.service.spec.ts (33 tests) 26ms
```

```bash
$ bun run test:unit src/agent-gateway/parsers/cursor/services/tests/cursor-agent-kv-turn.service.spec.ts

 ✓ src/agent-gateway/parsers/cursor/services/tests/cursor-agent-kv-turn.service.spec.ts (18 tests) 7ms
```

```bash
$ bun run test:unit src/agent-gateway/parsers/cursor/services/tests/cursor-parse-chat.service.spec.ts

 ✓ src/agent-gateway/parsers/cursor/services/tests/cursor-parse-chat.service.spec.ts (54 tests) 55ms
```

```bash
$ bun run test:unit src/agent-gateway/parsers/cursor/extractors/tests/usage.spec.ts

 ✓ src/agent-gateway/parsers/cursor/extractors/tests/usage.spec.ts (5 tests) 2ms
```

---

### 3.2 proxai_gateway Verification

#### 3.2.1 Typecheck
```bash
$ bun run typecheck
$ tsc --noEmit
# Completed successfully with no errors or warnings
```

#### 3.2.2 Lint
```bash
$ bun run lint
$ oxlint --deny-warnings
Found 0 warnings and 0 errors.
```

#### 3.2.3 Unit Tests
Ran the gateway tests to verify that `contextWindowStatusAtCreation` is kept while other fields are trimmed correctly.

```bash
$ bun test src/sources/cursor/tests/trim.test.ts

 7 pass
 0 fail
 Ran 7 tests across 1 file. [35.00ms]
```

---

## 4. Key Architectural Decisions Checked

- **Option A Design Confirmed:** Surfaces context size and code volume in `agent_metadata`; billed token columns remain `null`. This represents the most truthful layout, sidestepping dangerous heuristics.
- **No Schema Changes:** The gauges ride inside the existing `agent_metadata` JSONB column. No migrations or changes to `declaredFields` were made, bypassing unnecessary database drift.
- **No Accumulator Version Bump:** Bumping `ACCUMULATOR_VERSION` would reset active in-flight Cursor sessions. Keeping it at `1` allows backwards compatibility because the new properties are typed as optional and default correctly to null if missing.
- **Gauge Invariant Enforced:** Verified via regex audits that no gauge data path sums tokens across turns or populates `result.usage.input_tokens`.
