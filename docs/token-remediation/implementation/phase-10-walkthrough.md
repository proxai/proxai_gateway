# Phase 10 — Walkthrough Document

This document outlines the implementation and verification details of Phase 10 of the Token Remediation plan.

## 1. Overview
The goal of Phase 10 is to implement display-only adjustments to the agent analytics dashboard (`proxai_web` only):

1. **KPI label update**: Clarified the Token Usage KPI card's subtitle from `"Input + output tokens"` to `"Input + output + cache-read tokens"`. The underlying metric value sum consists of input, output, and cache-read tokens (a three-column sum), so referencing cache-read tokens matches what users see in the headline.
2. **Cursor "not captured" display**: Since Cursor token collection is deferred (Phase 8), Cursor rows have `NULL` token counts in the database. The backend coalesces these values to `0` on the wire, making Cursor indistinguishable from agents with a real-zero token count. We now identify the Cursor agent by its identifier (`agent === 'CURSOR'`) and display `"not captured"` for its four token cells (input, output, cache creation, and cache read). Other columns (RECORDS, TOOL CALLS, AVG DURATION) stay numeric, and other agents with genuinely zero tokens still render `"0"`.

---

## 2. Implemented Changes

### 2.1 Agent Metrics Dashboard
**File:** [agent-metrics-dashboard.tsx](file:///Users/onurseckinsenoglu/repos/proxai/proxai_web/app/dashboard/organization/(workspace)/analytics/acr/_components/agent-metrics-dashboard.tsx)

Updated the subtitle string for the `tokens` entry in the `AGENT_METRICS` array:

```diff
@@ -46,7 +46,7 @@
     formatValue: formatNumber,
     summaryPicker: (actual, cached) =>
       actual.totalTokenCount + cached.totalTokenCount,
-    subtitle: 'Input + output tokens',
+    subtitle: 'Input + output + cache-read tokens',
     aggregateValue: (actual, cached) =>
       formatNumber(actual.totalTokenCount + cached.totalTokenCount),
   },
```

### 2.2 Agent Stats Source Table
**File:** [acr-stats-org-source-table.tsx](file:///Users/onurseckinsenoglu/repos/proxai/proxai_web/app/dashboard/organization/(workspace)/analytics/acr/_components/acr-stats-org-source-table.tsx)

Extended imports, added the typed `CURSOR_AGENT` constant (preventing wire-contract name mismatch at compile time), implemented the `renderTokenCell` helper, and routed all four token cells of each row through it.

```diff
@@ -1,4 +1,5 @@
 'use client';
 
+import type { ReactNode } from 'react';
 import { IconCloud } from '@tabler/icons-react';
 import {
@@ -9,7 +10,7 @@
   TableRow,
   Typography,
 } from 'proxai-ui';
-import type { AgentStatsAgentEntry } from '@/services/organization';
+import type { AgentStatsAgentEntry, AgentKind } from '@/services/organization';
 import { TableEmptyBody } from '../../../../_components/table-empty-body';
 import { formatProviderName } from '@/lib/format/humanize';
 import {
@@ -18,6 +19,29 @@
 } from '../_lib/format-counters';
 import { ShareBar } from '../../sdk/_components/share-bar';
 
+/**
+ * Cursor token collection is deferred, so its input / output / cache columns are
+ * structurally absent: the backend stores NULL and COALESCEs to 0 on the wire,
+ * which is indistinguishable from a genuine zero. Agent identity is the only
+ * signal available client-side, so Cursor's token cells read "not captured" to
+ * keep no-data distinct from real-zero usage. Typed against AgentKind so a
+ * rename of the wire-contract agent set fails at compile time.
+ */
+const CURSOR_AGENT: AgentKind = 'CURSOR';
+
+const TOKENS_NOT_CAPTURED_LABEL = 'not captured';
+
+function renderTokenCell(notCaptured: boolean, value: number): ReactNode {
+  if (notCaptured) {
+    return (
+      <Typography as="span" variant="body" color="tertiary">
+        {TOKENS_NOT_CAPTURED_LABEL}
+      </Typography>
+    );
+  }
+  return formatTokens(value);
+}
+
 interface Props {
   entries: AgentStatsAgentEntry[];
 }
@@ -100,6 +124,7 @@
               totalRecords > 0
                 ? (entry.providerStatsData.totalQueries / totalRecords) * 100
                 : 0;
+            const tokensNotCaptured = entry.agent === CURSOR_AGENT;
             return (
               <TableRow key={entry.agent ?? 'unknown'}>
                 <TableCell className="min-w-[200px] align-middle">
@@ -121,13 +146,20 @@
                   {formatInteger(entry.providerStatsData.toolCallCount ?? 0)}
                 </TableCell>
                 <TableCell className="text-right align-middle font-mono">
-                  {formatTokens(entry.providerStatsData.totalInputTokens)}
-                </TableCell>
-                <TableCell className="text-right align-middle font-mono">
-                  {formatTokens(entry.providerStatsData.totalOutputTokens)}
-                </TableCell>
-                <TableCell className="text-right align-middle font-mono">
-                  {formatTokens(
+                  {renderTokenCell(
+                    tokensNotCaptured,
+                    entry.providerStatsData.totalInputTokens
+                  )}
+                </TableCell>
+                <TableCell className="text-right align-middle font-mono">
+                  {renderTokenCell(
+                    tokensNotCaptured,
+                    entry.providerStatsData.totalOutputTokens
+                  )}
+                </TableCell>
+                <TableCell className="text-right align-middle font-mono">
+                  {renderTokenCell(
+                    tokensNotCaptured,
                     entry.providerStatsData.cacheCreationTokens ?? 0
                   )}
                 </TableCell>
@@ -134,3 +166,6 @@
-                  {formatTokens(entry.providerStatsData.cacheReadTokens ?? 0)}
+                  {renderTokenCell(
+                    tokensNotCaptured,
+                    entry.providerStatsData.cacheReadTokens ?? 0
+                  )}
                 </TableCell>
                 <TableCell className="text-right align-middle font-mono">
```

### 2.3 Unit Test Changes
- **File:** [agent-metrics-dashboard.test.tsx](file:///Users/onurseckinsenoglu/repos/proxai/proxai_web/app/dashboard/organization/(workspace)/analytics/acr/_components/_tests/agent-metrics-dashboard.test.tsx)
  Added an `it()` test case verifying the Token Usage KPI subtitle displays `"Input + output + cache-read tokens"`.
- **File:** [acr-stats-org-source-table.test.tsx](file:///Users/onurseckinsenoglu/repos/proxai/proxai_web/app/dashboard/organization/(workspace)/analytics/acr/_components/_tests/acr-stats-org-source-table.test.tsx)
  Extended imports to include `within` and added two new test cases:
  1. `"renders 'not captured' for Cursor token cells instead of a misleading zero"` to verify Cursor rows correctly display `"not captured"` across the 4 token cells while keeping the records count numeric.
  2. `"renders genuine zero tokens as '0' for a token-capturing agent"` to verify other agents (e.g. `CLAUDE_CODE`) with zero tokens still display `"0"`.

---

## 3. Verification and Testing

### 3.1 TypeScript Typecheck
The type checks passed successfully in `proxai_web`:
```bash
$ bun run typecheck
$ tsc --noEmit
```

### 3.2 Unit Tests
All unit tests in the modified test files are green under Vitest:

- **Agent Metrics Dashboard Tests**:
  ```bash
  $ vitest run "app/dashboard/organization/(workspace)/analytics/acr/_components/_tests/agent-metrics-dashboard.test.tsx"
  
   ✓ app/dashboard/organization/(workspace)/analytics/acr/_components/_tests/agent-metrics-dashboard.test.tsx (3 tests) 35ms
  ```

- **Agent Source Stats Table Tests**:
  ```bash
  $ vitest run "app/dashboard/organization/(workspace)/analytics/acr/_components/_tests/acr-stats-org-source-table.test.tsx"
  
   ✓ app/dashboard/organization/(workspace)/analytics/acr/_components/_tests/acr-stats-org-source-table.test.tsx (8 tests) 47ms
  ```

### 3.3 Lint Check
Linter check passes successfully:
```bash
$ bun run lint
$ oxlint
Found 0 warnings and 0 errors.
```

---

## 4. Confirmations

- **Decision Gating**: The detection and gating of the Cursor agent uses `entry.agent === CURSOR_AGENT` (identifying the agent identity through the typed `AgentKind` constant), rather than looking for a zero/null value, ensuring that genuine zero tokens are rendered as `"0"` for other agents.
- **Scope Compliance**:
  - The SDK metrics card's subtitle has been kept unchanged (out of scope).
  - No backend code (`proxai_nest`), wire-contract API types, or other columns (RECORDS, TOOL CALLS, AVG DURATION) were modified.
  - The KPI value calculation functions (`extractor`, `summaryPicker`, `aggregateValue`) remain completely untouched.
- **Cache Creation Tokens Sum Audit**: Grep checks confirmed that no frontend sum folds `cacheCreationTokens` (which is a non-additive subset under the normalization scheme) into a total sum with input/output/cache-read tokens.
