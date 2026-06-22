# Phase 11 Walkthrough — Historical Prod Data Backfill

This document serves as the guide for the **operator** to prepare, dry-run, execute, and verify Phase 11 of the Token Remediation plan. 

Phase 11 corrects historical `agent_call_records` (ACRs) by re-feeding S3 captures through the updated and corrected parser logic deployed in Phases 2, 3, 5, and 7.

---

## 1. Code Changes & Verification

We implemented a `--limit=N` batching flag to prevent the script from overloading BullMQ and Postgres. 

### 1.1 Git Diff of the Source Changes

```diff
diff --git a/ai/tools/version-drift/reparse-chats.ts b/ai/tools/version-drift/reparse-chats.ts
index 94e27a3a..72ec4e87 100644
--- a/ai/tools/version-drift/reparse-chats.ts
+++ b/ai/tools/version-drift/reparse-chats.ts
@@ -321,8 +321,14 @@ async function main(): Promise<void> {
     }));
 
     const matches = candidates.filter(filter.matcher);
+    const limited =
+      parsed.limit !== null ? matches.slice(0, parsed.limit) : matches;
     process.stdout.write(
-      `reparse-chats: candidates=${candidates.length} matches=${matches.length}\n`,
+      `reparse-chats: candidates=${candidates.length} matches=${matches.length}` +
+        (parsed.limit !== null
+          ? ` limited_to=${limited.length} (--limit=${parsed.limit})`
+          : '') +
+        `\n`,
     );
 
     if (matches.length === 0) {
@@ -335,7 +341,7 @@ async function main(): Promise<void> {
 
     if (parsed.dryRun) {
       // Show enough detail to validate the selection before --execute.
-      const sample = matches.slice(0, 10);
+      const sample = limited.slice(0, 10);
       process.stdout.write(`reparse-chats: DRY-RUN. Sample (up to 10):\n`);
       for (const m of sample) {
         process.stdout.write(
@@ -344,9 +350,9 @@ async function main(): Promise<void> {
             `current_capture_asv=${m.currentAgentSchemaVersion ?? '<null>'}\n`,
         );
       }
-      if (matches.length > sample.length) {
+      if (limited.length > sample.length) {
         process.stdout.write(
-          `  ...and ${matches.length - sample.length} more\n`,
+          `  ...and ${limited.length - sample.length} more\n`,
         );
       }
       process.stdout.write(
@@ -358,7 +364,7 @@ async function main(): Promise<void> {
 
     // Prod typed-confirm (skipped with --yes for one-shot ops).
     if (parsed.env === 'prod' && !parsed.yes) {
-      const ok = await promptProdConfirm(parsed.env, matches.length);
+      const ok = await promptProdConfirm(parsed.env, limited.length);
       if (!ok) {
         process.stdout.write(
           `reparse-chats: confirmation mismatch; aborting.\n`,
@@ -371,7 +377,7 @@ async function main(): Promise<void> {
     // Clear AgentParseState fields per H-9: accumulator_blob, watermark,
     // capture_id, status, failed_reason. parser_version stays as-is —
     // the next parse tick rewrites it from the deployed parser code.
-    const ids: Array<{ agent: string; chatId: string }> = matches.map(
+    const ids: Array<{ agent: string; chatId: string }> = limited.map(
       (m: { agent: string; chatId: string }) => ({
         agent: m.agent,
         chatId: m.chatId,
@@ -399,7 +405,7 @@ async function main(): Promise<void> {
     // parse worker's per-file Redis SETNX gate dedups any concurrent
     // jobs anyway, but starting from one-per-file keeps the queue tidy.
     const fileTuples = new Map();
-    for (const m of matches) {
+    for (const m of limited) {
       const key = `${m.hostId}|${m.sourcePathHash}|${m.agent}`;
       // The cast is safe: parseArgs / validateArgs gate `--agent` against
       // `AgentAppNames`, and rows from `agent_parse_states.agent` carry
diff --git a/scripts/seed-lib/_tests/reparse-chats-args.spec.ts b/scripts/seed-lib/_tests/reparse-chats-args.spec.ts
index d11540d0..12f32d37 100644
--- a/scripts/seed-lib/_tests/reparse-chats-args.spec.ts
+++ b/scripts/seed-lib/_tests/reparse-chats-args.spec.ts
@@ -126,6 +126,31 @@ describe('seed-lib/reparse-chats-args', () => {
     it('throws on a positional argument (not prefixed with --)', () => {
       expect(() => parseArgs(['somevalue'])).toThrow('unknown argument');
     });
+
+    it('parses --limit=N into a positive integer', () => {
+      expect(
+        parseArgs(['--env=prod', '--filter=status=ACTIVE', '--limit=500'])
+          .limit,
+      ).toBe(500);
+    });
+
+    it('defaults limit to null when --limit is absent', () => {
+      expect(
+        parseArgs(['--env=prod', '--filter=status=ACTIVE']).limit,
+      ).toBeNull();
+    });
+
+    it('rejects a non-positive or non-integer --limit', () => {
+      expect(() => parseArgs(['--limit=0'])).toThrow(
+        '--limit must be a positive integer',
+      );
+      expect(() => parseArgs(['--limit=-5'])).toThrow(
+        '--limit must be a positive integer',
+      );
+      expect(() => parseArgs(['--limit=abc'])).toThrow(
+        '--limit must be a positive integer',
+      );
+    });
   });
 
   describe('validateArgs', () => {
@@ -139,6 +164,7 @@ describe('seed-lib/reparse-chats-args', () => {
         execute: false,
         yes: false,
         help: false,
+        limit: null,
         ...overrides,
       };
     }
diff --git a/scripts/seed-lib/reparse-chats-args.ts b/scripts/seed-lib/reparse-chats-args.ts
index bb319b90..18f723b2 100644
--- a/scripts/seed-lib/reparse-chats-args.ts
+++ b/scripts/seed-lib/reparse-chats-args.ts
@@ -47,6 +47,22 @@ export interface ReparseArgs {
   execute: boolean;
   yes: boolean;
   help: boolean;
+  /**
+   * Optional cap on how many matched chats this run clears + enqueues.
+   * Lets the operator chunk a full-history backfill into throttled batches
+   * and watch agent-parse queue depth between runs. Null = no cap (all
+   * matched chats).
+   *
+   * Successive limited runs self-drain regardless of row order: each run
+   * re-parses an arbitrary <=N subset, whose AgentParseState rows then have
+   * their parser_version rewritten to the deployed value and so drop out of
+   * the next run's `parser_version<NEW` match set. (The candidate fetch at
+   * reparse-chats.ts uses `findMany({ where })` with NO `orderBy`, so the
+   * matched subset is NOT stable/ordered across runs — do not rely on a
+   * deterministic (agent, chat_id) ordering; rely only on the parser_version
+   * filter shrinking the remainder each pass.)
+   */
+  limit: number | null;
 }
 
 
@@ -105,6 +121,7 @@ export function parseArgs(argv: readonly string[]): ReparseArgs {
     execute: false,
     yes: false,
     help: false,
+    limit: null,
   };
 
   for (const raw of argv) {
@@ -122,6 +139,14 @@ export function parseArgs(argv: readonly string[]): ReparseArgs {
       args.chatId = raw.slice('--chat-id='.length);
     } else if (raw.startsWith('--agent=')) {
       args.agent = raw.slice('--agent='.length);
+    } else if (raw.startsWith('--limit=')) {
+      const value = Number(raw.slice('--limit='.length));
+      if (!Number.isInteger(value) || value <= 0) {
+        throw new Error(
+          `--limit must be a positive integer, got: ${raw.slice('--limit='.length)}`,
+        );
+      }
+      args.limit = value;
     } else {
       throw new Error(`unknown argument: ${raw} (run with --help for usage)`);
     }
```

### 1.2 Verification Results
- **TypeScript Typecheck:** `bun run typecheck` passes with no errors. No prohibited TypeScript `any` types were introduced.
- **Unit Specs:** 
  - `bun run test:unit scripts/seed-lib/_tests/reparse-chats-args.spec.ts` (72/72 passed)
  - `bun run test:unit ai/tools/version-drift/tests/reparse-chats.spec.ts` (33/33 passed)
- **Validation Gate:** `bun run validate` passes completely (including linter, metric cardinality audit, and application build).

---

## 2. ⚠️ The Shrink-Guard Veto Trap

The `ParseBatchUpsertService` uses the Phase 4 shrink-guard to prevent corruption:
```sql
WHERE
  agent_call_records.last_capture_watermark_end IS NULL
  OR (
    EXCLUDED.last_capture_watermark_end IS NOT NULL
    AND EXCLUDED.last_capture_watermark_end > agent_call_records.last_capture_watermark_end
  )
```
Because this comparison is a strict `>` (strictly greater than), re-parsing a **dormant chat** (which produces an *equal* watermark) will fail to overwrite the token columns. The database transaction completes with zero errors, and `AgentParseState.parser_version` advances, but the stale tokens stay stale.

---

## 3. Heal Strategy Decision Guide

Before executing the live backfill, the operator must select a heal strategy:

| Strategy | Behavior | Pros | Cons / Blast Radius |
|---|---|---|---|
| **Option A: DELETE-then-reparse** | Delete target rows using raw DML, then run re-parse script. | Heals dormant and active rows alike. | **Heavy blast radius**: Cascades to `breadcrumb_records`, destroying classification rows that are costly to rebuild, and desynchronizes denormalized stats. |
| **Option B: Naive reparse-only** *(Recommended First Pass)* | Run script with `--execute`. No manual DML. | Safest path. Zero risk of corruption. Populates `CLAUDE_DESKTOP` cleanly. | Leaves dormant rows stale. |
| **Option C: Guarded equal-watermark code change** | Extend backend code to support an equal-watermark overwrite for tokens. | Complete heal of tokens without cascade loss. | Requires additional Nest source code deployment. |

**Recommended Path:**
1. Execute **Option B** for all agents first. This populates `CLAUDE_DESKTOP` completely (since there are no existing rows) and heals active chats.
2. Confirm the number of remaining stale/dormant rows.
3. If necessary, decide between **Option A** (accepting cascade and running stats-rebuild script) and **Option C** (deploying a code patch).

---

## 4. Backfill Runbook (Operator Commands)

> **Pre-requisite:** Verify that Phases 2, 3, 5, and 7 are fully deployed to the target environment.

### 4.1 Dry-Runs (Always Run First)
Record the `matches=` count for each agent to confirm the change scope:

```bash
# 1. CLAUDE_DESKTOP (Expected: non-zero match count, status UNSUPPORTED_VERSION)
bun ai/tools/version-drift/reparse-chats.ts --env=prod \
  --filter=status=UNSUPPORTED_VERSION --agent=CLAUDE_DESKTOP

# 2. CODEX (Replace <NEW_CODEX_VER> with deployed parser version, e.g., 0.129.0)
bun ai/tools/version-drift/reparse-chats.ts --env=prod \
  --filter='parser_version<<NEW_CODEX_VER>' --agent=CODEX

# 3. gemini (Replace <NEW_GEMINI_VER> with deployed version)
bun ai/tools/version-drift/reparse-chats.ts --env=prod \
  --filter='parser_version<<NEW_GEMINI_VER>' --agent=gemini

# 4. CLAUDE_CODE (Replace <NEW_CC_VER> with deployed version)
bun ai/tools/version-drift/reparse-chats.ts --env=prod \
  --filter='parser_version<<NEW_CC_VER>' --agent=CLAUDE_CODE
```

### 4.2 Execute Run

```bash
# 1. Populate CLAUDE_DESKTOP (Option B, safe fresh populate)
bun ai/tools/version-drift/reparse-chats.ts --env=prod \
  --filter=status=UNSUPPORTED_VERSION --agent=CLAUDE_DESKTOP --execute

# 2. Re-parse other agents in throttled batches
bun ai/tools/version-drift/reparse-chats.ts --env=prod \
  --filter='parser_version<<NEW_CODEX_VER>' --agent=CODEX --limit=500 --execute

bun ai/tools/version-drift/reparse-chats.ts --env=prod \
  --filter='parser_version<<NEW_GEMINI_VER>' --agent=gemini --limit=500 --execute

bun ai/tools/version-drift/reparse-chats.ts --env=prod \
  --filter='parser_version<<NEW_CC_VER>' --agent=CLAUDE_CODE --limit=500 --execute
```
*Note: Type the exact confirmation phrase printed by the CLI when prompting.*

---

## 5. Verification Spot-Check (Read-Only DB Connection)

Run these checks to prove the heal actually updated the table columns.

### 5.1 Codex Over-count Drop
Compare tokens for a specific multi-turn CODEX chat session:
```sql
SELECT 
  chat_id, 
  SUM(input_tokens) as total_input, 
  SUM(cache_read_input_tokens) as total_cache_read
FROM agent_call_records 
WHERE agent = 'CODEX' AND chat_id = '<SESS_ID>'
GROUP BY chat_id;
```
*Expectation:* Total input tokens should drop after reparse if it was healed. (If unchanged, the shrink-guard vetoed it).

### 5.2 Gemini Phantom Cache Creation Removal
Check that phantom cache creation input tokens are null:
```sql
SELECT id, input_tokens, cache_creation_input_tokens
FROM agent_call_records
WHERE agent = 'gemini' AND chat_id = '<SESS_ID>'
LIMIT 10;
```
*Expectation:* `cache_creation_input_tokens` should be `NULL` for Gemini records.

### 5.3 Claude Desktop Populate
```sql
SELECT COUNT(*) 
FROM agent_call_records 
WHERE agent = 'CLAUDE_DESKTOP';
```
*Expectation:* Count goes from `0` to a non-zero count representing all historical matches.

### 5.4 Claude Code Idle Loop Flushes
Check that idle loops which were flushed mid-run have their continuation tokens recorded.

---

## 6. Permanent Gap Caveat (F1 Dialogue Filter)

⚠️ **Important Stakeholder Notice:** 
The Claude Code F1 dialogue-filter drop occurred at the **gateway level prior to S3 upload**. The raw tool usage data was never written to S3 captures. Consequently, re-parsing S3 captures **cannot recover** these dropped records. Only Claude Code records created *after* the Phase 1 gateway fix was shipped are correct. 
Re-parsing CLAUDE_CODE is still valuable because it heals the Phase 5 idle-flush orphan-drop, but it will not recover F1 under-counts.
