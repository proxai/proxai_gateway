# Phase 7 Walkthrough — Claude Desktop Version Resolution

This walkthrough details the implementation, tests, and verification steps for Phase 7 of the Token Remediation plan.

---

## 1. Files Changed

### `proxai_nest`
* `src/agent-gateway/parsers/parsers.versions.ts`: Defined `claudeDesktopScheme` (prefixed-semver version scheme stripping the `claude-desktop/` prefix, with explicit support to map the `claude-desktop/v2` sentinel to `true` to route it to the newest Claude Code parser). Configured `VERSION_SCHEMES.CLAUDE_DESKTOP` to use this new scheme.
* `src/agent-gateway/parsers/tests/parsers.versions.spec.ts`: Updated existing unit tests to use prefixed versions, added new tests ensuring prefix requirements and out-of-range gating behavior, and verified that the `v2` sentinel resolves properly. Replaced the `VERSION_SCHEMES.CLAUDE_DESKTOP === VERSION_SCHEMES.CLAUDE_CODE` identity test with matcher-behavior assertions.
* `src/agent-gateway/parsers/claude-code/services/tests/claude-code-parse-chat.service.spec.ts`: Added a new unit test asserting that a `CLAUDE_DESKTOP` chat bundle with the `claude-desktop/v2` version resolves and yields correct Phase 1 summed usage values.
* `ai/knowledge/agent-gateway/desktop-routing.md`: Documented the version resolution mechanism and the `claude-desktop/` prefix contract. Updated the routing anchors count and table.

### `proxai_gateway`
* `src/sources/claude-desktop/collect.ts`: Modified the collector to import `isUsageBearingAssistantRecord` from `sources/claude-code` and union it with `isDialogueRecord` in the kept condition. This prevents intermediate `tool_use` events from being discarded before upload.
* `src/sources/claude-desktop/tests/collect.test.ts`: Added a new unit test verifying that usage-bearing `tool_use` records are kept and uploaded correctly.

---

## 2. Source Diffs

### `proxai_nest`

#### `parsers.versions.ts`
```diff
diff --git a/src/agent-gateway/parsers/parsers.versions.ts b/src/agent-gateway/parsers/parsers.versions.ts
index 61fc2373..cb86d3ad 100644
--- a/src/agent-gateway/parsers/parsers.versions.ts
+++ b/src/agent-gateway/parsers/parsers.versions.ts
@@ -177,13 +177,64 @@ const geminiScheme: VersionScheme = {
   },
 };
 
+/**
+ * Claude Desktop embeds the Claude Code CLI binary and writes byte-identical
+ * JSONL, so the on-disk `version` field is the embedded CLI's semver. The
+ * gateway namespaces `agent_schema_version` as the `claude-desktop/` prefix
+ * followed by that value (`claude-desktop/2.1.122`), or the schema-marker
+ * sentinel `claude-desktop/v2` when the embedded CLI's version could not be
+ * read off the transcript (gateway `CLAUDE_DESKTOP_DEFAULT_AGENT_SCHEMA_VERSION`).
+ *
+ * The prefix is stripped here so a known CLI semver matches the SAME ranges as
+ * Claude Code (the range array is shared by reference) and is gated identically
+ * — `claude-desktop/3.0.0` falls to UNSUPPORTED_VERSION exactly as a bare
+ * `3.0.0` would for CC. The `v2` sentinel carries no CLI semver; because
+ * Desktop IS the CC CLI, it resolves to the newest registered CC parser
+ * instead of being lost to UNSUPPORTED_VERSION. Range expressions stay written
+ * prefix-free (e.g. `>=2.1.0 <2.2.0`), identical to the CC/Codex entries.
+ */
+const CLAUDE_DESKTOP_SCHEMA_PREFIX = 'claude-desktop/';
+
+/**
+ * Cross-repo contract: the gateway stamps `claude-desktop/<this>` as the
+ * default when no CLI semver is available. Mirror of
+ * `proxai_gateway/src/sources/claude-desktop/claude-desktop.constants.ts`
+ * (`CLAUDE_DESKTOP_DEFAULT_AGENT_SCHEMA_VERSION = 'claude-desktop/v2'`). It is
+ * a capture-schema marker, NOT a CLI semver, so it cannot satisfy a semver
+ * range and is matched explicitly.
+ */
+const CLAUDE_DESKTOP_VERSION_SENTINEL = 'v2';
+
+function stripClaudeDesktopPrefix(incoming: string): string | null {
+  if (!incoming.startsWith(CLAUDE_DESKTOP_SCHEMA_PREFIX)) return null;
+  const rest = incoming.slice(CLAUDE_DESKTOP_SCHEMA_PREFIX.length);
+  return rest.length > 0 ? rest : null;
+}
+
+const claudeDesktopScheme: VersionScheme = {
+  kind: 'prefixed-semver',
+  match: (incoming, range) => {
+    const version = stripClaudeDesktopPrefix(incoming);
+    if (version === null) return false;
+    // Unknown-CLI schema marker → Desktop embeds the CC CLI, so route to
+    // whichever range matched first (resolution is newest-first). Returning
+    // true here makes the dominant real-world Desktop stamp resolve to the
+    // newest CC parser instead of UNSUPPORTED_VERSION.
+    if (version === CLAUDE_DESKTOP_VERSION_SENTINEL) return true;
+    return semver.valid(version) ? semver.satisfies(version, range) : false;
+  },
+};
+
 export const VERSION_SCHEMES: Record<AgentAppName, VersionScheme> = {
   CLAUDE_CODE: semverScheme,
   // CLAUDE_DESKTOP embeds the Claude Code CLI binary and stamps the embedded
   // CLI's semver into every JSONL event's `version` field — NOT the Desktop
-  // app's own version (1.x.x at the time of writing). So Desktop uses the
-  // same scheme as CC.
-  CLAUDE_DESKTOP: semverScheme,
+  // app's own version. The gateway namespaces that value as
+  // `claude-desktop/<cli-semver>` (or the `claude-desktop/v2` schema-marker
+  // sentinel when the CLI semver is unknown), so Desktop resolves through the
+  // prefix-stripping `claudeDesktopScheme` — NOT the bare semver scheme —
+  // against the shared CC version ranges.
+  CLAUDE_DESKTOP: claudeDesktopScheme,
   CURSOR: cursorScheme,
   CODEX: semverScheme,
   gemini: geminiScheme,
```

#### `parsers.versions.spec.ts`
```diff
diff --git a/src/agent-gateway/parsers/tests/parsers.versions.spec.ts b/src/agent-gateway/parsers/tests/parsers.versions.spec.ts
index d23203f6..1926c69b 100644
--- a/src/agent-gateway/parsers/tests/parsers.versions.spec.ts
+++ b/src/agent-gateway/parsers/tests/parsers.versions.spec.ts
@@ -159,18 +159,30 @@ describe('resolveParserSet', () => {
   // identity invariant test below guards the alias; this test verifies the
   // resolution path produces the same parserSet for both agents on a
   // representative in-range version.
-  it('returns claude-code/v1 for CLAUDE_DESKTOP on in-range CC schema versions', () => {
-    const desktop = resolveParserSet('CLAUDE_DESKTOP', '2.1.92');
+  it('returns claude-code/v1 for CLAUDE_DESKTOP on a prefixed in-range CC schema version', () => {
+    const desktop = resolveParserSet('CLAUDE_DESKTOP', 'claude-desktop/2.1.92');
     const cc = resolveParserSet('CLAUDE_CODE', '2.1.92');
     expect(desktop?.parserSet).toBe('claude-code/v1');
     expect(desktop?.parserSet).toBe(cc?.parserSet);
     expect(desktop?.declaredFields).toBe(cc?.declaredFields); // same array reference
   });
 
-  it('returns null for CLAUDE_DESKTOP out-of-range versions, matching CC behaviour', () => {
-    expect(resolveParserSet('CLAUDE_DESKTOP', '3.0.0')).toBeNull();
-    expect(resolveParserSet('CLAUDE_DESKTOP', '1.0.0')).toBeNull();
-    expect(resolveParserSet('CLAUDE_DESKTOP', 'garbage')).toBeNull();
+  it('returns null for prefixed CLAUDE_DESKTOP versions outside the CC range', () => {
+    expect(resolveParserSet('CLAUDE_DESKTOP', 'claude-desktop/3.0.0')).toBeNull();
+    expect(resolveParserSet('CLAUDE_DESKTOP', 'claude-desktop/1.2.3')).toBeNull();
+    expect(resolveParserSet('CLAUDE_DESKTOP', 'claude-desktop/garbage')).toBeNull();
+  });
+
+  it('requires the claude-desktop/ prefix — a bare semver does not resolve for CLAUDE_DESKTOP', () => {
+    expect(resolveParserSet('CLAUDE_DESKTOP', '2.1.92')).toBeNull();
+    expect(resolveParserSet('CLAUDE_DESKTOP', 'v2')).toBeNull();
+    expect(resolveParserSet('CLAUDE_DESKTOP', '')).toBeNull();
+  });
+
+  it('resolves the prefixed claude-desktop/v2 schema sentinel to the Claude Code parser set', () => {
+    const r = resolveParserSet('CLAUDE_DESKTOP', 'claude-desktop/v2');
+    expect(r?.parserSet).toBe('claude-code/v1');
+    expect(r?.declaredFields).toContain('result.usage.input_tokens');
   });
 
   it('resolves any composer._v with bubble=3 to cursor/v1; bubble!=3 still null', () => {
@@ -392,10 +404,19 @@ describe('CLAUDE_DESKTOP shares CC version-range array by reference', () => {
     );
   });
 
-  it('VERSION_SCHEMES.CLAUDE_DESKTOP uses the same scheme as CLAUDE_CODE', () => {
-    // Desktop embeds the CC CLI; the on-disk `version` field is the CLI's
-    // semver. So Desktop must use semverScheme, identical to CC.
-    expect(VERSION_SCHEMES.CLAUDE_DESKTOP).toBe(VERSION_SCHEMES.CLAUDE_CODE);
+  it('VERSION_SCHEMES.CLAUDE_DESKTOP strips the claude-desktop/ prefix before applying the CC range', () => {
+    const m = VERSION_SCHEMES.CLAUDE_DESKTOP.match;
+    // Prefixed real semver gated against the CC range.
+    expect(m('claude-desktop/2.1.92', '>=2.1.0 <2.2.0')).toBe(true);
+    expect(m('claude-desktop/3.0.0', '>=2.1.0 <2.2.0')).toBe(false);
+    // The v2 schema sentinel routes through regardless of the range (unknown CLI → newest CC parser).
+    expect(m('claude-desktop/v2', '>=2.1.0 <2.2.0')).toBe(true);
+    // The prefix is mandatory; a bare semver never matches.
+    expect(m('2.1.92', '>=2.1.0 <2.2.0')).toBe(false);
+    expect(m('claude-desktop/garbage', '>=2.1.0 <2.2.0')).toBe(false);
+    expect(m('claude-desktop/', '>=2.1.0 <2.2.0')).toBe(false);
+    // It is NOT the same object as the bare CC scheme anymore.
+    expect(VERSION_SCHEMES.CLAUDE_DESKTOP).not.toBe(VERSION_SCHEMES.CLAUDE_CODE);
   });
```

#### `claude-code-parse-chat.service.spec.ts`
```diff
diff --git a/src/agent-gateway/parsers/claude-code/services/tests/claude-code-parse-chat.service.spec.ts b/src/agent-gateway/parsers/claude-code/services/tests/claude-code-parse-chat.service.spec.ts
index 9b3d4909..640958da 100644
--- a/src/agent-gateway/parsers/claude-code/services/tests/claude-code-parse-chat.service.spec.ts
+++ b/src/agent-gateway/parsers/claude-code/services/tests/claude-code-parse-chat.service.spec.ts
@@ -1333,6 +1333,86 @@ describe('ClaudeCodeParseChatService', () => {
     });
     expect(ccLabeled).toHaveLength(0);
   });
+
+  it('produces a CLAUDE_DESKTOP ACR with the Phase-1-folded summed usage via the shared CC parser', async () => {
+    const desktopService = makeService();
+    const chat = makeChat([
+      makeChunk('cap-1', 100n, [
+        {
+          type: 'user',
+          uuid: 'u-1',
+          sessionId: 'sess-1',
+          version: '2.1.92',
+          promptId: 'p-1',
+          timestamp: '2026-04-01T00:00:00Z',
+          message: { role: 'user', content: 'read foo' },
+        },
+        // Assistant tool_use call — NO promptId; carries per-call usage.
+        {
+          type: 'assistant',
+          uuid: 'a-1',
+          parentUuid: 'u-1',
+          sessionId: 'sess-1',
+          timestamp: '2026-04-01T00:00:01Z',
+          message: {
+            model: 'claude-sonnet-4-5',
+            content: [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: { path: 'foo' } }],
+            usage: {
+              input_tokens: 100,
+              output_tokens: 20,
+              cache_creation_input_tokens: 50,
+              cache_read_input_tokens: 10,
+            },
+          },
+        },
+        // Final assistant text — NO promptId; terminal text + stop_reason + usage.
+        {
+          type: 'assistant',
+          uuid: 'a-2',
+          parentUuid: 'a-1',
+          sessionId: 'sess-1',
+          timestamp: '2026-04-01T00:00:02Z',
+          message: {
+            model: 'claude-sonnet-4-5',
+            content: [{ type: 'text', text: 'done' }],
+            stop_reason: 'end_turn',
+            usage: {
+              input_tokens: 5,
+              output_tokens: 80,
+              cache_creation_input_tokens: 0,
+              cache_read_input_tokens: 600,
+            },
+          },
+        },
+        // Boundary record (new promptId 'p-2') so 'p-1' finalizes instead of buffering.
+        {
+          type: 'user',
+          uuid: 'u-2',
+          sessionId: 'sess-1',
+          version: '2.1.92',
+          promptId: 'p-2',
+          timestamp: '2026-04-01T00:00:10Z',
+          message: { role: 'user', content: 'next' },
+        },
+      ]),
+    ]);
+    chat.agent = 'CLAUDE_DESKTOP'; // routes to ClaudeCodeParserService via the registry fall-through
+    chat.lastAgentSchemaVersion = 'claude-desktop/v2'; // the gateway's default Desktop stamp
+
+    const result = await desktopService.parseChat(null, chat, '1.0.0');
+    // Only the p-1 turn finalizes (p-2 stays open). One ACR carrying the SUMMED
+    // loop usage with the Phase-1 fold (input 105 raw + cache_creation 50 = 155).
+    expect(result.records).toHaveLength(1);
+    const usage = result.records[0].result.usage;
+    expect(usage?.input_tokens).toBe(155); // (100+5) raw input + (50+0) cache_creation
+    expect(usage?.output_tokens).toBe(100); // 20 + 80
+    expect(usage?.cache_creation_input_tokens).toBe(50); // raw, kept (non-additive subset)
+    expect(usage?.cache_read_input_tokens).toBe(610); // 10 + 600
+    // The agent lives top-level and on the capture stamp — NOT on chatStamp
+    // (chatStamp = { chat_id, agent_id, chat_title, created_at_utc }).
+    expect(result.records[0].agent).toBe('CLAUDE_DESKTOP');
+    expect(result.records[0].capture.agent).toBe('CLAUDE_DESKTOP');
+  });
 });
```

### `proxai_gateway`

#### `collect.ts`
```diff
diff --git a/src/sources/claude-desktop/collect.ts b/src/sources/claude-desktop/collect.ts
index 126f364..3e1555f 100644
--- a/src/sources/claude-desktop/collect.ts
+++ b/src/sources/claude-desktop/collect.ts
@@ -24,7 +24,7 @@ import type {
   ClaudeDesktopCollectorResult,
   DiscoveredClaudeDesktopFile,
 } from 'sources/claude-desktop/claude-desktop.types.ts';
-import { isDialogueRecord } from 'sources/claude-code';
+import { isDialogueRecord, isUsageBearingAssistantRecord } from 'sources/claude-code';
 
 const DECODER = new TextDecoder('utf-8', { fatal: false });
 const ENCODER = new TextEncoder();
@@ -118,7 +118,15 @@ export async function collectClaudeDesktopFile(
       if (line.trim().length === 0) continue;
       try {
         const parsed = JSON.parse(line);
-        if (parsed.isReplay === true || !isDialogueRecord(parsed)) {
+        // Keep telemetry-bearing assistant records (tool_use steps carrying
+        // per-call `usage`) alongside the display-filtered dialogue records,
+        // so the backend's aggregateUsage sums the full agentic loop instead
+        // of only the final text record. Mirrors the Claude Code collector's
+        // union; Desktop embeds the same CLI and routes to the same parser.
+        if (
+          parsed.isReplay === true ||
+          !(isDialogueRecord(parsed) || isUsageBearingAssistantRecord(parsed))
+        ) {
           continue;
         }
```

#### `collect.test.ts`
```diff
diff --git a/src/sources/claude-desktop/tests/collect.test.ts b/src/sources/claude-desktop/tests/collect.test.ts
index 52b9e0b..39eda7d 100644
--- a/src/sources/claude-desktop/tests/collect.test.ts
+++ b/src/sources/claude-desktop/tests/collect.test.ts
@@ -288,4 +288,69 @@ describe('collectClaudeDesktopFile', () => {
     db.close();
     await rmRecursive(testDir);
   });
+
+  test('keeps usage-bearing tool_use assistant records so the full Desktop loop reaches the backend', async () => {
+    const db = openInMemoryBufferDb();
+    const testDir = await mkdtemp(join(tmpdir(), 'proxai-test-claude-desktop-'));
+    const tempFile = join(testDir, 'audit.jsonl');
+
+    const auditContent =
+      [
+        JSON.stringify({
+          type: 'user',
+          uuid: 'u-1',
+          session_id: 'sess-1',
+          message: { role: 'user', content: 'read foo' },
+        }),
+        JSON.stringify({
+          type: 'assistant',
+          message: {
+            role: 'assistant',
+            id: 'msg-tool',
+            content: [{ type: 'tool_use', id: 'toolu_desktop', name: 'Read' }],
+            usage: { input_tokens: 3, output_tokens: 4 },
+          },
+        }),
+        JSON.stringify({
+          type: 'assistant',
+          message: {
+            role: 'assistant',
+            id: 'msg-text',
+            content: [{ type: 'text', text: 'done' }],
+            usage: { input_tokens: 5, output_tokens: 6 },
+          },
+        }),
+        '',
+      ].join('\n') + '\n';
+    await writeFile(tempFile, auditContent);
+
+    const stat = await statFile(tempFile);
+    if (!stat.exists) throw new Error(`Test file not found: ${tempFile}`);
+    const file: DiscoveredClaudeDesktopFile = {
+      sourcePath: tempFile,
+      sourcePathHash: 'hash-desktop-usage',
+      inode: Number(stat.inode),
+      sizeBytes: stat.size,
+      lastModifiedMs: Date.now(),
+    };
+
+    const res = await collectClaudeDesktopFile(file, {
+      buffer: db,
+      maxDecompressedBytes: 10_000,
+    });
+    expect(res.errors).toEqual([]);
+    expect(res.capturedBatches).toBe(1);
+
+    const batch = requireDefined(nextPendingBatch(db));
+    const body = new TextDecoder().decode(zstdDecompressSync(batch.body));
+    // The intermediate tool_use call and its per-call usage survive to the body.
+    expect(body).toContain('toolu_desktop');
+    expect(body).toContain('"input_tokens":3');
+    expect(body).toContain('"output_tokens":4');
+    // The final text record is present too (regression guard for normal records).
+    expect(body).toContain('"input_tokens":5');
+
+    db.close();
+    await rmRecursive(testDir);
+  });
 });
```

---

## 3. Test Results

### `proxai_nest`

#### `parsers.versions.spec.ts` unit tests
```
$ bun run test:unit src/agent-gateway/parsers/tests/parsers.versions.spec.ts
vitest run src/agent-gateway/parsers/tests/parsers.versions.spec.ts
 ✓ src/agent-gateway/parsers/tests/parsers.versions.spec.ts (36 tests) 10ms
```
Status: **Passed**

#### `claude-code-parse-chat.service.spec.ts` unit tests
```
$ bun run test:unit src/agent-gateway/parsers/claude-code/services/tests/claude-code-parse-chat.service.spec.ts
vitest run src/agent-gateway/parsers/claude-code/services/tests/claude-code-parse-chat.service.spec.ts
 ✓ src/agent-gateway/parsers/claude-code/services/tests/claude-code-parse-chat.service.spec.ts (55 tests) 57ms
```
Status: **Passed**

#### Typecheck
```
$ bun run typecheck
$ tsc --noEmit
```
Status: **Passed**

#### Linter
```
$ bun run lint
$ oxlint
Found 0 warnings and 0 errors.
```
Status: **Passed**

### `proxai_gateway`

#### `collect.test.ts` unit tests
```
$ bun test src/sources/claude-desktop/tests/collect.test.ts
bun test v1.3.14 (0d9b296a)
 8 pass
 0 fail
```
Status: **Passed**

#### Typecheck
```
$ bun run typecheck
$ tsc --noEmit
```
Status: **Passed**

#### Linter
```
$ bun run lint
$ oxlint --deny-warnings
Found 0 warnings and 0 errors.
```
Status: **Passed**

---

## 4. Dual-Repo Invariant Confirmations
* **`any` uses**: Checked. No uses of TypeScript `any` in any code or tests.
* **Suppression comments**: None. No `@ts-ignore`, `@ts-expect-error`, or equivalent.
* **No before/after framing in tests**: Confirmed. Tests describe current behavior using factual assertions only.
* **By-reference version alias preserved**: Confirmed. The `KNOWN_AGENT_SCHEMA_VERSIONS.CLAUDE_DESKTOP` alias to `CLAUDE_CODE_VERSION_RANGES` was left completely untouched. Unit tests for reference identity still pass.

---

## 5. Sequencing Confirmation
We confirm that Phase 1, Phase 4, and Phase 5 changes are already merged in the workspace (indicated by the presence of `isUsageBearingAssistantRecord` in the gateway codebase, and the parser tests verifying token aggregation fold). This ensures that routing `CLAUDE_DESKTOP` to the shared parser now accurately aggregates token usage without under-counting.

---

## 6. Flagged Decisions Resolved
* **sentinel v2 handling**: Resolved by treating the `v2` sentinel as "unknown CLI version", routing it to the newest CC parser as per Change 1's prefix-stripping matching logic.
* **gateway collector change**: Applied the recommended change in `proxai_gateway` to union the kept condition with `isUsageBearingAssistantRecord`, ensuring that telemetry-bearing intermediate assistant records are preserved.
