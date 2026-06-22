# Token Remediation Post-Phase 11 Feedback & Findings

This document collects architectural findings, gotchas, permanent data caveats, and proposed operational decision matrices discovered during the execution of Phases 1 to 11 of the Token Remediation plan. 

This summary is structured for ingest by an advanced reasoning LLM to evaluate follow-up code changes or operator decisions.

---

## 1. The Stale-Spec Veto Trap (Phase 11 Backfill)

### 1.1 The Issue
The Phase 11 backfill script (`reparse-chats.ts`) re-feeds S3 captures through the corrected parsing logic. However, for historical dormant chats (chats that haven't generated new active turns since the initial buggy parser run), the S3 captures will produce the **same watermark end value** as what is currently stored in the database.

`ParseBatchUpsertService` has a strict DO UPDATE gate on watermarks:
```sql
WHERE
  agent_call_records.last_capture_watermark_end IS NULL
  OR (
    EXCLUDED.last_capture_watermark_end IS NOT NULL
    AND EXCLUDED.last_capture_watermark_end > agent_call_records.last_capture_watermark_end
  )
```
Because the re-parsed watermark is equal to (not strictly greater than) the database watermark, the database upsert for those rows **evaluates to false and silently ignores the updates**. The backfill script completes successfully and bumps the `parser_version` on `AgentParseState`, but the actual token count columns in `agent_call_records` are **not updated** for those dormant rows.

### 1.2 Operational Decision Matrix
To resolve this veto and heal the dormant rows, the operator must select one of the following approaches:

| Strategy | Blast Radius | Implementation Effort | Side-Effects |
|---|---|---|---|
| **Option A: DELETE-then-reparse** | High | Low (CLI commands) | Cascades to `breadcrumb_records`, deleting classification rows carrying LLM cost metrics. Requires running a full statistics rebuild afterwards (`rebuild-breadcrumb-local-stats.ts`). |
| **Option B: Naive re-parse** | Zero | Low (Run default backfill) | Safe. Heals active chats and cleanly populates `CLAUDE_DESKTOP` (which have no existing rows). Leaves dormant rows stale. |
| **Option C: Guarded force-heal code path** | Low | Medium (Modify Nest source) | Temporarily alter the upsert SQL to overwrite only token columns when watermarks are equal, bypassing the strict watermark check for this run. |

**Recommendation:** Run Option B first to populate `CLAUDE_DESKTOP` and active chats, verify the remaining dormant stale count, and then decide between Option A and Option C.

---

## 2. F1 Claude Code Ingest Loss Caveat

The Dialogue Filter (F1) occurred directly at the gateway layer **before** the dialogue payload was uploaded to the S3 bucket. 

* **The Trap:** Because the filter ran pre-upload, the S3 captures **do not contain** the tool-use records or final text for F1-filtered turns. 
* **Impact:** Re-parsing S3 historical captures **cannot recover** the under-counted tokens for F1-filtered turns. Those historical counts are permanently lost.
* **Resolution:** Stakeholders must accept this historical margin of error, noting that the live collector now preserves tool-use records (Phase 1) preventing future drift.

---

## 3. Web UI "Not Captured" vs. Database Nulls (Phase 10)

During Phase 8, Cursor token collection was deferred. In the database, Cursor records have `NULL` token counts. 

* **The Problem:** The backend API coalesces database `NULL` token values to `0` on the wire. This made Cursor token cells display as `"0"` in the dashboard, making it look like Cursor was successfully captured but consumed zero tokens (misleading).
* **The Solution:** Rather than altering database nullability or Nest wire-contract schemas (which would impact metrics calculations and historical calculations), we handled this as a **display-only client-side adjustment** in `proxai_web`:
  * Detect the Cursor agent (`agent === 'CURSOR'`) using typed `AgentKind` constants.
  * Render `"not captured"` for its four token cells (input, output, cache-create, cache-read) while keeping records, tool calls, and avg duration numeric.
  * Verify that genuine zero tokens for other agents (like `CLAUDE_CODE`) still render as `"0"`.

---

## 4. Telemetry Registry and Observability

We introduced two new metrics in `src/telemetry/metric-kind-registry.ts` to monitor the new guards in production:
1. `agent_gateway_parse_shrink_rejected_total` (counter): Tracks the number of DO UPDATE writes vetoed by the Phase 4 token-shrink guard (watermark advanced but tokens would shrink).
2. `agent_gateway_parser_reattach_dropped_total` (counter): Tracks the number of re-emitted `task_started` events dropped by the Phase 6 Codex re-attach guard.

Verify that the OpenTelemetry / Prometheus collection dashboards are updated to track these counters to catch parser anomalies in real-time.

---

## 5. Type-Safety Boundaries & SOLID Decoupling

During Round 3 (Verifier C) audits, we identified and corrected two major architectural design issues:

### 5.1 Type-Safety Boundary Leaks (`JSON.parse` Implicit Any)
* **The Issue:** The gateway local database query collectors (such as `src/sources/claude-desktop/collect.ts` and `src/sources/cursor/process-rows.ts`) used `JSON.parse(row.value)` directly without type annotation. Because `JSON.parse` returns `any`, these values leaked implicit `any` properties throughout subsequent expressions, bypassing compiler check guarantees.
* **The Fix:** We annotated all deserialized JSON variables as `unknown` and introduced explicit runtime type-guards / property casting (e.g. `parsed as { text?: unknown }` or checking object structure). This enforces strict type-safety at the serialization boundary.

### 5.2 SOLID/DIP Utility Decoupling
* **The Issue:** The utility library `parsers.utils.ts` in Nest statically imported `@sentry/nestjs` and `Logger`. This was an SRP/DIP violation that forced all downstream service callers and unit tests of pure parsing logic to transitively import and mock heavy infrastructure telemetry dependencies.
* **The Fix:** We removed all logging and monitoring imports from `parsers.utils.ts`, making it a pure stateless library. The memoized capability probe check `isBlake2bAvailable()` is now exported as a pure side-effect-free capability detection method. The alarms and metrics registration logic are deferred to `AgentGatewayModule.onModuleInit()`, running exactly once per process at startup.

