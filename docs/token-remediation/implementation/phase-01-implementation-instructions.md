# Phase 1 — Implementation Instructions (for the implementer model)

> **Audience:** the small/fast implementer model that will write the code.
> **Author:** orchestrator chat (source-verified against both repos on 2026-06-17).
> **Companion specs (already settled — do not re-open):**
> `../phase-01-claude-code-usage-preservation.md`, `../ROADMAP.md`,
> `../analysis/CROSS-SOURCE-NORMALIZATION.md`.
>
> This single document is everything you need. Every file path, line, and code
> block below was read from the actual source. **Follow it literally.** If
> reality on disk disagrees with a snippet here (line numbers may drift), trust
> the *named symbol* (function/interface name), not the line number, and apply
> the same change at the symbol.

---

## 0. TL;DR — what you are doing

Claude Code is the most-used agent (~15.5k records) and it **under-counts tokens
by ~75%**. The cause is in **two repos**, and you will make **two small, surgical
changes** plus tests:

1. **`proxai_gateway`** — stop the collector from dropping the assistant records
   that carry per-call `usage` (the tool-calling steps of an agentic loop)
   *before* they are uploaded. Today they never reach the backend, so the
   backend can only sum the final text record.
2. **`proxai_nest`** — when those records now arrive, fold Anthropic's
   `cache_creation_input_tokens` into the stored `inputTokens` ("fresh input")
   while **keeping** the raw cache-creation value in its own column.

That is the whole job. There is **no schema change, no new module, no queue
change, no migration**. The backend's turn-assembly already expects these
records — the gateway was simply stripping them.

**Total surface:** 1 gateway source file + 2 gateway test files; 1 nest source
file + 1 nest test file.

---

## 1. Hard rules (apply to BOTH repos — non-negotiable)

These are enforced by lint/CI and by human reviewers. Violating any one fails the phase.

- **No `any`.** Not `: any`, not `as any`, not `Promise<any>`, not `Record<string, any>`,
  not an implicit any. Use `unknown` + a type guard at boundaries. This holds in
  `.ts` **and** `.spec.ts` / `.test.ts` files. Both repos ban it.
- **No suppression comments.** No `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`,
  `eslint-disable`, `oxlint-disable`, `v8 ignore`. If types fight you, fix the type
  — do not silence the tool. If a third-party type *forces* an any, **stop and report
  it** instead of inserting one.
- **No "before/after" references** in code, comments, or test names. Describe current
  behavior only. Do **not** write `// previously this dropped tool_use` in shipped code.
  Test names describe behavior (`it('folds cache_creation into inputTokens', ...)`),
  never mechanics or line numbers.
- **Comments explain *why*, not *what*.** No decorative banners, no restating the code.
- **Package manager is `bun`** in both repos. Never `npm`/`pnpm`/`yarn`.
- **Do not run the full validate/build gate** while iterating. Run the **file-specific
  test** for the file you touched, plus `typecheck`. (Commands in §6.)
- **Git:** do **not** commit, push, branch, or stage anything unless the operator
  explicitly tells you to. Make the edits and leave them in the working tree. The
  operator owns the branch and the PRs.

---

## 2. The bug, precisely (so you understand what you're fixing)

### 2.1 The gateway drop (root cause)

`proxai_gateway/src/sources/claude-code/collect.ts` has a predicate
**`isDialogueRecord(parsed)`** that decides which JSONL lines get uploaded. It is a
**display** filter, and it **drops every assistant record that contains a `tool_use`
block**:

- a **pure** `tool_use` assistant record (no text) is dropped by the "no text" gate;
- a **mixed** text + `tool_use` assistant record is dropped by the "has tool_use" gate
  (losing both its usage *and* its text).

Only lines for which `isDialogueRecord` returns `true` are pushed into `kept` and
uploaded (the `kept.push(...)` call inside `collectClaudeCodeFile`). So the
intermediate tool-calling API calls — each a **separately-billed Anthropic request
carrying its own `usage`** — are discarded before upload.

A Claude Code turn = `1 user prompt + N assistant tool-use cycles + final text`.
Anthropic reports `usage` **per request** (not cumulative). The N cycles carry the
bulk of the cache/output tokens. They are gone, so the backend can only sum the
final text record → ~75% under-count.

Proof in-repo: the fixture
`proxai_gateway/src/sources/claude-code/tests/fixtures/session-basic.jsonl` already
contains a pure `tool_use` assistant record (with its own `usage: input_tokens:3,
output_tokens:4`) right next to a text assistant record (`usage: input_tokens:1,
output_tokens:2`) — distinct per-call usage.

### 2.2 The backend side (already correct — needs no structural change)

`proxai_nest/src/agent-gateway/parsers/claude-code/claude-code.utils.ts` →
`aggregateUsage(records)` **sums `message.usage` over every `assistant` record it
receives**. It does **not** re-apply the gateway's filter. So the moment the gateway
stops dropping the tool_use records, `aggregateUsage` sums the whole loop
automatically. **You do not change `aggregateUsage` and you do not change
turn-assembly.** (Reassurance in §5.)

The only backend change is the column-normalization fold (§4).

---

## 3. CHANGE 1 — `proxai_gateway` (stop dropping usage-bearing records)

**File:** `proxai_gateway/src/sources/claude-code/collect.ts`

The approach (ratified by the operator) is a **surgical union**: keep
`isDialogueRecord` exactly as it is (it is shared by Claude Desktop and the
poll-worker — see §3.5), and add a **second, separate** predicate that preserves
telemetry. The upload filter ORs the two. Each line is still evaluated once and kept
at most once → no duplication, no double-count.

### 3.1 Extend the private `ClaudeRecord` interface to see `usage`

Find this interface near the top of `collect.ts`:

```ts
interface ClaudeRecord {
  type?: unknown;
  isMeta?: unknown;
  isApiErrorMessage?: unknown;
  message?: { content?: ClaudeContent; text?: unknown; model?: unknown };
  content?: ClaudeContent;
  text?: unknown;
}
```

Add `usage?: unknown;` to the inline `message` type:

```ts
interface ClaudeRecord {
  type?: unknown;
  isMeta?: unknown;
  isApiErrorMessage?: unknown;
  message?: {
    content?: ClaudeContent;
    text?: unknown;
    model?: unknown;
    usage?: unknown;
  };
  content?: ClaudeContent;
  text?: unknown;
}
```

### 3.2 Add the new exported predicate

Insert this function **immediately after** the `isDialogueRecord` function closes
(after its final `}`). It is `export`ed; because `src/sources/claude-code/index.ts`
does `export * from 'sources/claude-code/collect.ts'`, it becomes importable as
`import { isUsageBearingAssistantRecord } from 'sources/claude-code'` with **no barrel
edit**.

```ts
/**
 * Telemetry-preservation predicate (split out from the display filter).
 *
 * `isDialogueRecord` is a DISPLAY filter: it drops every assistant record that
 * carries a `tool_use` block, which also discards that record's per-call
 * `usage`. In an agentic loop those intermediate tool-calling API calls are
 * separately billed by Anthropic and carry the bulk of the turn's cache/output
 * tokens, so dropping them makes the backend's `aggregateUsage` sum only the
 * final text record. This predicate keeps the telemetry: it returns true for a
 * real (non-meta, non-synthetic, non-api-error) assistant record that carries a
 * `usage` block. The upload filter ORs the two predicates, so each line is
 * evaluated once and kept at most once — display filtering and telemetry
 * preservation are separate concerns by design.
 */
export function isUsageBearingAssistantRecord(parsed: unknown): boolean {
  if (parsed === null || typeof parsed !== 'object') {
    return false;
  }
  const record = parsed as ClaudeRecord;
  if (record.type !== 'assistant') {
    return false;
  }
  if (record.isMeta === true) {
    return false;
  }
  // Synthetic-model and api-error records are not real billable model calls —
  // keep them dropped, exactly as the display filter does.
  if (
    record.message?.model === '<synthetic>' ||
    record.isApiErrorMessage === true
  ) {
    return false;
  }
  const usage = record.message?.usage;
  return usage !== null && typeof usage === 'object';
}
```

> Why "has a `usage` block" rather than "has a `tool_use` block": the goal is to
> preserve *billable usage*. Any assistant record carrying a `usage` object is a
> real API call whose tokens must be summed. This cleanly captures pure-tool_use,
> mixed text+tool_use, and thinking-only records, while the synthetic/meta/api-error
> guards keep out the non-billable noise. (The final text record already passes
> `isDialogueRecord`, so the OR keeps it once.)

### 3.3 Wire it into the upload filter

Find the `kept` decision inside `collectClaudeCodeFile` (the loop over `lines`):

```ts
      if (line.trim().length > 0) {
        try {
          const parsed = JSON.parse(line);
          if (isDialogueRecord(parsed)) {
            kept.push({
              text: line,
              physicalEndOffset: lineEndOffset,
            });
          }
        } catch {}
      }
```

Change the single condition to the union:

```ts
      if (line.trim().length > 0) {
        try {
          const parsed = JSON.parse(line);
          if (isDialogueRecord(parsed) || isUsageBearingAssistantRecord(parsed)) {
            kept.push({
              text: line,
              physicalEndOffset: lineEndOffset,
            });
          }
        } catch {}
      }
```

That is the **entire** gateway source change. Do not touch the slice/offset math, the
redaction, the cursor logic, or anything else — they all derive from `kept` and keep
working when `kept` simply contains more lines.

### 3.4 Gateway tests to add

The gateway uses **`bun:test`** (globals `test`, `expect`, imported from `'bun:test'`).

**(a) Predicate unit tests** — add to
`proxai_gateway/src/sources/claude-code/tests/synthetic-filter.test.ts`. First extend
its existing import:

```ts
import { isDialogueRecord, isUsageBearingAssistantRecord } from 'sources/claude-code';
```

Then add:

```ts
test('isUsageBearingAssistantRecord: keeps tool_use assistant records carrying usage', () => {
  expect(
    isUsageBearingAssistantRecord({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 't', name: 'Read' }],
        usage: { input_tokens: 3, output_tokens: 4 },
      },
    }),
  ).toBe(true);
});

test('isUsageBearingAssistantRecord: drops assistant records with no usage block', () => {
  expect(
    isUsageBearingAssistantRecord({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't', name: 'Read' }] },
    }),
  ).toBe(false);
});

test('isUsageBearingAssistantRecord: drops synthetic, api-error, and meta records even with usage', () => {
  expect(
    isUsageBearingAssistantRecord({
      type: 'assistant',
      message: { model: '<synthetic>', usage: { input_tokens: 1 } },
    }),
  ).toBe(false);
  expect(
    isUsageBearingAssistantRecord({
      type: 'assistant',
      isApiErrorMessage: true,
      message: { usage: { input_tokens: 1 } },
    }),
  ).toBe(false);
  expect(
    isUsageBearingAssistantRecord({
      type: 'assistant',
      isMeta: true,
      message: { usage: { input_tokens: 1 } },
    }),
  ).toBe(false);
});

test('isUsageBearingAssistantRecord: drops non-assistant and non-object inputs', () => {
  expect(
    isUsageBearingAssistantRecord({ type: 'user', message: { usage: {} } }),
  ).toBe(false);
  expect(isUsageBearingAssistantRecord(null)).toBe(false);
  expect(isUsageBearingAssistantRecord('x')).toBe(false);
});
```

**(b) End-to-end body test** — add to
`proxai_gateway/src/sources/claude-code/tests/collect.test.ts`. This proves the
intermediate tool_use call's usage actually survives into the uploaded (decompressed)
body. It reuses the file's existing helpers (`makeFile`, `ctx`, `DECODER`,
`nextPendingBatch`, `zstdDecompressSync`, `requireDefined` — all already imported in
that file):

```ts
test('uploads usage-bearing tool_use assistant records so the full agentic loop reaches the backend', async () => {
  // user prompt -> intermediate tool_use call (its OWN usage) -> final text.
  const content =
    [
      '{"type":"user","promptId":"p1","message":{"role":"user","content":"read foo"},"uuid":"u1","sessionId":"s1","version":"2.1.122"}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_xyz","name":"Read","input":{"file_path":"foo.txt"}}],"stop_reason":"tool_use","usage":{"input_tokens":3,"output_tokens":4,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}},"uuid":"u2","sessionId":"s1","version":"2.1.122"}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"stop_reason":"end_turn","usage":{"input_tokens":5,"output_tokens":6,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}},"uuid":"u3","sessionId":"s1","version":"2.1.122"}',
      '',
    ].join('\n');
  const file = await makeFile(content);
  await collectClaudeCodeFile(file, ctx(buffer));
  const batch = nextPendingBatch(buffer);
  expect(batch).not.toBeNull();
  const body = DECODER.decode(zstdDecompressSync(requireDefined(batch).body));
  // The intermediate tool_use call and its per-call usage survive to the body.
  expect(body).toContain('"toolu_xyz"');
  expect(body).toContain('"input_tokens":3');
  expect(body).toContain('"output_tokens":4');
  // The final text record is present too (regression guard for normal records).
  expect(body).toContain('"input_tokens":5');
});
```

> Regression coverage for text-only turns already exists in `collect.test.ts`
> (e.g. the early "inserts a batch", "advances cursor", "redacts secrets" tests use
> text-only content). Confirm they still pass — they must, because the new predicate
> only *adds* records; it never removes any.

### 3.5 Gateway — what you must NOT touch

- **Do NOT modify `isDialogueRecord`.** It is imported by
  `src/sources/claude-desktop/collect.ts` and `src/services/polling/poll-worker.ts`.
  Changing it would leak this phase into Claude Desktop (a *different* phase) and the
  poll-worker's diagnostics. Leave it byte-for-byte unchanged.
- **Do NOT touch `claude-desktop/` or `poll-worker.ts`.** Out of scope.
- **Do NOT upload "all lines"** or add an `isDialogueVisible` flag. The operator
  chose the surgical predicate specifically to avoid sending meta/synthetic/tool_result
  records (which the backend does not filter) and to minimize upload-volume growth.

---

## 4. CHANGE 2 — `proxai_nest` (fold cache_creation into inputTokens)

This is the column-normalization decision, **already settled** (see
`../ROADMAP.md` → "Column normalization" and `../analysis/CROSS-SOURCE-NORMALIZATION.md`).
Do not re-open the semantics. The rule:

| Column | Store as | Note |
|---|---|---|
| `inputTokens` | **fresh input** = `input_tokens + cache_creation_input_tokens` | tokens written to cache are billed at ~full rate → they are "fresh input" |
| `cacheCreationInputTokens` | the **raw** `cache_creation_input_tokens` | KEEP it; it is a **non-additive SUBSET** of `inputTokens`. **Never add it into any grand total.** |
| `cacheReadInputTokens` | unchanged | disjoint from inputTokens |
| `outputTokens` | unchanged | includes reasoning |

Invariant after the fold: `0 ≤ cacheCreationInputTokens ≤ inputTokens` (Claude).

### 4.1 The fold goes in the Claude-Code usage extractor — NOT the shared spine

**File:** `proxai_nest/src/agent-gateway/parsers/claude-code/extractors/usage.ts`

> **Critical — read this.** The companion phase spec points at
> `build-scalar-spine.ts:162`. **Do not fold there.** `build-scalar-spine.ts` is the
> **shared, agent-agnostic** flatten used by all four parsers (Claude Code, Cursor,
> Codex, Gemini). Folding there would wrongly apply Claude's `input + cache_creation`
> math to Codex and Gemini (whose folds are different and handled in Phases 2 & 3).
> The correct, per-agent fold site is the Claude-Code `inputTokensExtractor`. Verified:
> in `claude-code-finalize-turn.service.ts` the stored `result.usage.input_tokens`
> comes from `getValue('result.usage.input_tokens')` — i.e. this extractor — not from
> the raw `aggregateUsage` roll-up.

Find:

```ts
export const inputTokensExtractor: FieldExtractor<number> = {
  field: 'result.usage.input_tokens',
  supports: '>=2.0.0 <3.0.0',
  extract: pickNumber((u) => u.input_tokens),
};
```

Replace with:

```ts
export const inputTokensExtractor: FieldExtractor<number> = {
  field: 'result.usage.input_tokens',
  supports: '>=2.0.0 <3.0.0',
  // Store inputTokens as FRESH INPUT = raw input_tokens + cache_creation_input_tokens.
  // Tokens written to the prompt cache are billed at ~full rate, so they belong in
  // "fresh input"; this makes Claude's inputTokens directly comparable to Gemini/Codex.
  // The raw cache-write count is preserved separately by cacheCreationInputTokensExtractor
  // (a non-additive subset of this value — never add it into a grand total). Null only
  // when the turn carried no usage block at all (input_tokens === null).
  extract: pickNumber((u) =>
    u.input_tokens === null
      ? null
      : u.input_tokens + (u.cache_creation_input_tokens ?? 0),
  ),
};
```

> Type note: `aggregateUsage` returns `input_tokens: number | null` and
> `cache_creation_input_tokens: number | null`; when any usage was seen both are
> numbers, otherwise both null. The `=== null ? null : … + (… ?? 0)` shape is
> type-safe with no cast and no `any`. The invariant holds by construction because
> stored input = raw + cacheCreation ≥ cacheCreation (raw ≥ 0).

### 4.2 Leave the other three usage extractors UNCHANGED

`outputTokensExtractor`, `cacheReadInputTokensExtractor`, and
**`cacheCreationInputTokensExtractor`** stay exactly as they are.
`cacheCreationInputTokensExtractor` must keep returning the **raw** value — do **not**
null it.

### 4.3 Do NOT change these (and why)

- **`claude-code.utils.ts` → `aggregateUsage`**: leave it a pure summer. It is also
  consumed for `service_tier` and the ephemeral counters; folding there would corrupt
  those readers and the invariant.
- **`build-scalar-spine.ts`**: agent-agnostic, see §4.1.
- **`claude-code-finalize-turn.service.ts`**: no change. It already reads the folded
  value through the extractor and already sums the (now larger) record set correctly.

### 4.4 Nest tests

The backend uses **Vitest** via `bun run test:unit`.

**File:** `proxai_nest/src/agent-gateway/parsers/claude-code/extractors/tests/usage.spec.ts`

**(a) Update the existing roll-up test** — it currently asserts `inputTokens === 1000`
for `input_tokens:1000, cache_creation_input_tokens:100`. With the fold it is `1100`.
In the test named `'uses ctx.scratch.usage when present (caches the aggregateUsage
roll-up)'`, change the `inputTokensExtractor` expectation:

```ts
    expect(inputTokensExtractor.extract({}, ctx)).toEqual({
      value: 1100, // fresh input = input_tokens(1000) + cache_creation(100)
      confidence: 'authoritative',
    });
```

Leave the `outputTokensExtractor` (500), `cacheReadInputTokensExtractor` (200), and
`cacheCreationInputTokensExtractor` (100) expectations in that test unchanged.

> The other existing tests stay green as-is: the "fallback to aggregateUsage" test
> uses records with no cache_creation (fold adds 0 → still 30); the "null" tests have
> `input_tokens: null` (fold returns null).

**(b) Add a dedicated fold + invariant test** in the same `describe` block:

```ts
  it('folds cache_creation into inputTokens, keeps the raw cache-creation column, and holds the subset invariant', () => {
    const usage = {
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 200,
      cache_creation_input_tokens: 100,
    };
    const ctx = makeCtx({ usage });

    const input = inputTokensExtractor.extract({}, ctx).value;
    const cacheCreation = cacheCreationInputTokensExtractor.extract({}, ctx).value;

    expect(input).toBe(1100); // 1000 fresh tail + 100 written to cache
    expect(cacheCreation).toBe(100); // raw value preserved, not nulled
    expect(cacheReadInputTokensExtractor.extract({}, ctx).value).toBe(200); // disjoint
    expect(outputTokensExtractor.extract({}, ctx).value).toBe(500); // untouched

    // Invariant: cache-creation is a non-additive subset of fresh input.
    expect(typeof input).toBe('number');
    expect(typeof cacheCreation).toBe('number');
    if (typeof input === 'number' && typeof cacheCreation === 'number') {
      expect(cacheCreation).toBeGreaterThanOrEqual(0);
      expect(cacheCreation).toBeLessThanOrEqual(input);
    }
  });
```

### 4.5 Audit step (verification only — likely NO code change)

Confirm no nest aggregate adds `cacheCreationInputTokens` into a total (it must stay a
non-additive subset). Run in `proxai_nest`:

```bash
grep -rn "cacheCreationInputTokens\|cache_creation_input_tokens" src/ \
  | grep -iv "test\|spec"
```

Expected: it appears only where it is **written/mapped** (e.g.
`build-scalar-spine.ts`, the batch upsert) and **never** inside a `+`/`SUM` that also
adds input/output/cacheRead. The prior analysis already confirmed the web "Token Usage"
KPI is `input + output + cacheRead` (it excludes cacheCreation), so it is correct as-is.
**If — and only if — you find a path that adds `cacheCreationInputTokens` into a grand
total, do not "fix" it silently: stop and report it** in your hand-back (§7). It would
become a double-count under the new scheme.

---

## 5. Why no backend turn-assembly change is needed (reassurance)

You might worry that feeding more records per turn creates phantom turns or breaks
boundaries. It does not, and here is the proof from
`proxai_nest/.../services/claude-code-parse-chat.service.ts`:

- A Claude Code **turn boundary is keyed on `promptId`**, and **only `user` records
  carry `promptId`**. **Assistant records carry no `promptId`** — they append to the
  currently-open turn (the service comment says exactly this:
  "ASSISTANT records carry no promptId — they belong to the most recent user prompt's
  turn").
- The streaming model the file documents is literally
  "1 user prompt + N assistant tool-use cycles + M tool_result envelopes + lifecycle
  noise." The assembler was **built for** the N cycles. The gateway was starving it.
- You are only adding **assistant** records (no `promptId`). They fold into the open
  turn. They cannot start a new turn. No phantom turns, no boundary change.
- `final_text` scans `resultContent` backward for the last **TEXT** block; tool_use
  records project to **TOOL** blocks, so `final_text` is unaffected for normal turns.
  `stop_reason` back-scans assistant records and is robust to the extra records.

So the change is genuinely "stop dropping + fold the column." Nothing else.

> Not backfillable (set expectations): these records were dropped **before** S3 upload,
> so historical Claude Code data cannot be recovered by re-parsing. Only captures taken
> **after** this ships are correct. (This is why Phase 11's backfill explicitly excludes
> F1 history.) Nothing for you to do here — just don't be surprised that old data stays
> low.

---

## 6. Execution order & commands

Work the two repos independently (no ordering dependency between them, but do both).

### proxai_gateway
1. Edit `src/sources/claude-code/collect.ts` (§3.1 → §3.3).
2. Add tests (§3.4).
3. Run:
   ```bash
   bun run typecheck
   bun test src/sources/claude-code/tests/collect.test.ts
   bun test src/sources/claude-code/tests/synthetic-filter.test.ts
   bun run lint
   ```

### proxai_nest
1. Edit `src/agent-gateway/parsers/claude-code/extractors/usage.ts` (§4.1).
2. Update + add tests (§4.4).
3. Run the audit grep (§4.5).
4. Run:
   ```bash
   bun run typecheck
   bun run test:unit src/agent-gateway/parsers/claude-code/extractors/tests/usage.spec.ts
   ```
   (Optionally also run the finalize-turn / parse-chat specs in the same folder tree to
   confirm no incidental breakage — but do **not** run the full `bun run validate` gate
   while iterating.)

If any command fails, fix the cause — never silence it with a suppression comment or an
`any`.

---

## 7. Hand-back report (what to send back to the orchestrator / verifier)

When done, report **exactly** this so the Opus verifier can check it fast:

1. **Files changed** (path + one-line description), for both repos.
2. **The two source diffs** pasted verbatim (`collect.ts` predicate + filter; `usage.ts`
   extractor).
3. **Test results**: paste the pass output of each command in §6.
4. **Audit-grep result** (§4.5): state whether any total path adds
   `cacheCreationInputTokens`. If yes — describe it and **do not change it**; flag it.
5. **Anything you could not do without an `any` or a suppression** — name the exact type
   friction instead of working around it.
6. Confirm you did **not** touch: `isDialogueRecord`, `claude-desktop/`, `poll-worker.ts`,
   `aggregateUsage`, `build-scalar-spine.ts`, `claude-code-finalize-turn.service.ts`, or
   any schema/migration.

---

## 8. Acceptance criteria (the verifier will check all of these)

- [ ] tool_use-bearing assistant records' `usage` reaches the backend — the gateway no
      longer discards them pre-upload (proved by the §3.4(b) body test).
- [ ] Backend `aggregateUsage` now sums the full loop: a multi-tool-call turn's stored
      input/output/cache exceeds the old text-only sum by the recovered calls' usage
      (mechanically true once the records arrive — no backend change needed).
- [ ] No regression for text-only turns; no double-count (each line kept once).
- [ ] `inputTokens = input_tokens + cache_creation_input_tokens` (fresh input);
      `cacheCreationInputTokens` KEPT as the raw value (subset of inputTokens, not nulled).
- [ ] Tests assert: the fold, the invariant `0 ≤ cacheCreationInputTokens ≤ inputTokens`,
      and (via the §4.5 audit) that no total-computing path adds `cacheCreationInputTokens`.
- [ ] All new/updated gateway and nest tests are green; `typecheck` and `lint` pass.
- [ ] No `any`, no suppression comments, no before/after references; conventional-commit
      discipline left to the operator.

---

## 9. Out of scope (do NOT do these — they are other phases or non-goals)

- Codex over-count (Phase 2), Gemini phantom cache_creation (Phase 3), upsert
  shrink-guard (Phase 4), idle-flush orphan-drop (Phase 5), Codex re-attach (Phase 6),
  Claude Desktop version resolution (Phase 7), Cursor (Phase 8, deferred), id hardening
  (Phase 9), web display (Phase 10), historical backfill (Phase 11).
- Any reasoning-token field / new schema column (explicitly skipped — `outputTokens`
  stays the combined visible+reasoning total).
- The poll-worker telemetry counter (`telemetryRecordCount`) will under-count tool_use
  records since it still uses `isDialogueRecord` — this is **observability-only and out
  of scope**. Note it in your report if you like, but do not change it.
