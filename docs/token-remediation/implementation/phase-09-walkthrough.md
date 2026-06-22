# Phase 9 — Walkthrough Document

This document outlines the implementation and verification details of Phase 9 of the Token Remediation plan.

## 1. Overview
The goal of Phase 9 is to make the `blake2b512` hashing fallback louder and safer. In Node.js environments where the `blake2b512` algorithm is unavailable (e.g., FIPS-constrained configurations), the system falls back to deterministic record-ID generation using truncated `sha256` hashing. Previously, the system logged a warning via `console.warn` upon fallback, which could easily be overlooked or silenced.

The remediation replaces `console.warn` with:
- A Grafana-visible counter metric `agent_gateway_parser_record_id_hash_downgraded_total`.
- A Sentry capture message (`Sentry.captureMessage`) configured with `fingerprint` for deduplication and severity set to `error`.

To respect SOLID/DIP principles and ensure utility purity, the capability detection is encapsulated as a pure function in `parsers.utils.ts`, while the side-effecting telemetry alarm is decoupled and executed on startup in `agent-gateway.module.ts`.

Because the blake2b availability check is memoized at module load, this telemetry triggers exactly **once per process** rather than hot-looping on every ID generated.

---

## 2. Implemented Changes

### 2.1 Product Code Changes
**File:** [parsers.utils.ts](file:///Users/onurseckinsenoglu/repos/proxai/proxai_nest/src/agent-gateway/parsers/parsers.utils.ts)
We updated `isBlake2bAvailable` to be a pure capability checker without Sentry or Logger imports, and exported it for boot-time probing.

```diff
@@ -29,2 +29,2 @@
- * No NestJS imports; pure functions only — safe to call from any service or
- * test fixture.
+ * These helpers use no NestJS dependency injection — they are importable from any
+ * service or test fixture. The one side effect is the memoized blake2b availability
+ * probe, which emits a metric + Sentry alarm (once per process) when the runtime
+ * forces the sha256 record-id fallback.
@@ -37,2 +37,4 @@
 import { createHash } from 'node:crypto';
-import type { AgentAppName } from '../agent-gateway.types';
+
+import type { AgentAppName } from '../agent-gateway.types';
@@ -58,1 +58,1 @@
-function isBlake2bAvailable(): boolean {
+export function isBlake2bAvailable(): boolean {
@@ -66,5 +66,0 @@
-    console.warn(
-      '[parsers] blake2b512 unavailable; falling back to sha256 truncation. ' +
-        'Re-parse compatibility may break across this boundary.',
-    );
```

### 2.2 Startup Telemetry Changes
**File:** [agent-gateway.module.ts](file:///Users/onurseckinsenoglu/repos/proxai/proxai_nest/src/agent-gateway/agent-gateway.module.ts)
We integrated the capability check inside `AgentGatewayModule.onModuleInit()`. When the module boots up, it checks if `blake2b512` is available, and if not, it fires a Grafana metric increment and a Sentry error alert exactly once per process.

```diff
@@ -27,2 +27,4 @@
 import { listRegisteredVersionRanges } from './parsers/parsers.versions';
+import * as Sentry from '@sentry/nestjs';
+import { isBlake2bAvailable } from './parsers/parsers.utils';
 import { RedactionModule } from './redaction/redaction.module';
@@ -209,3 +211,18 @@
     Logger.process.info('agent-gateway', 'parsers', 'registry-loaded', {
       ranges: listRegisteredVersionRanges(),
     });
+
+    if (!isBlake2bAvailable()) {
+      Logger.metric(
+        'agent_gateway_parser_record_id_hash_downgraded_total',
+        1,
+        {},
+      );
+      Sentry.captureMessage(
+        'deterministicRecordId: blake2b512 unavailable; record ids minted via sha256 ' +
+          'truncation — id identity diverges from blake2b across the fallback boundary',
+        {
+          level: 'error',
+          fingerprint: ['parsers-blake2b-unavailable'],
+          extra: { algorithm: 'sha256' },
+        },
+      );
+    }
```

### 2.3 Telemetry Registry Changes
**File:** [metric-kind-registry.ts](file:///Users/onurseckinsenoglu/repos/proxai/proxai_nest/src/telemetry/metric-kind-registry.ts)
Registered the `agent_gateway_parser_record_id_hash_downgraded_total` metric as a `'counter'` to satisfy OTLP validation.

```diff
@@ -161,2 +161,3 @@
     agent_gateway_parser_provider_inferred_total: 'counter',
+    agent_gateway_parser_record_id_hash_downgraded_total: 'counter',
     agent_gateway_parser_replay_filtered_other_composer_total: 'counter',
```

### 2.4 Test Code Changes
**File:** [parsers.utils.spec.ts](file:///Users/onurseckinsenoglu/repos/proxai/proxai_nest/src/agent-gateway/parsers/tests/parsers.utils.spec.ts)
Updated the fallback test to check that the helper correctly detects capability failure and memoization, without requiring Sentry or Logger mocks.

---

## 3. Verification and Testing

### 3.1 Typecheck
TypeScript type checks run completely clean:
```bash
$ bun run typecheck
$ tsc --noEmit
```

### 3.2 Unit Tests
All unit tests passed successfully under Vitest:
```bash
$ vitest run src/agent-gateway/parsers/tests/parsers.utils.spec.ts

 ✓ src/agent-gateway/parsers/tests/parsers.utils.spec.ts (5 tests) 12ms
     ✓ creates stable deterministic record ids
     ✓ still returns an id and detects false capability when blake2b512 is unavailable
     ✓ memoizes the capability check correctly
     ✓ builds plain text message content
     ✓ builds plain and encrypted thinking content

 Test Files  1 passed (1)
      Tests  5 passed (5)
   Start at  14:41:25
   Duration  187ms (transform 52ms, setup 70ms, import 16ms, tests 12ms, environment 0ms)
```

Metric Kind Registry tests:
```bash
$ vitest run src/telemetry/tests/metric-kind-registry.spec.ts

 ✓ src/telemetry/tests/metric-kind-registry.spec.ts (3 tests) 136ms

 Test Files  1 passed (1)
      Tests  3 passed (3)
   Start at  13:07:57
   Duration  276ms (transform 28ms, setup 37ms, import 20ms, tests 136ms, environment 0ms)
```
