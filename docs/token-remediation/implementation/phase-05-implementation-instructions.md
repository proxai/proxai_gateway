# Phase 5 — Implementation Instructions (for the implementer model)

> **Audience:** the small/fast implementer model that will write the code.
> **Author:** orchestrator chat (source-verified against `proxai_nest` on 2026-06-17).
> **Companion specs (already settled — do not re-open):**
> `../phase-05-claude-code-orphan-drop.md`, `../ROADMAP.md`,
> `../analysis/VERIFICATION_FINDINGS.md` §10.3/§11.2/§11.3,
> `../analysis/IMPLEMENTATION_PLAN.md` Rank 5, `../phase-04-upsert-shrink-guard.md`.
>
> Everything you need is here. Every path/line/snippet below was read from the
> actual source on disk. **Follow it literally.** If a line number has drifted,
> trust the *named symbol* (function / interface / branch), not the line number.
>
> **This phase is `proxai_nest` ONLY.** No gateway change. No schema/migration change.

---

## 0. TL;DR — what you are doing

After the Claude Code idle-flush cron force-closes a stuck open turn, it nulls that
turn's open-turn lineage. On the **next** parse tick the post-flush continuation
records (assistant + `tool_result`, which carry **no `promptId`**) arrive with no
turn open and are **silently dropped** at the orphan branch — their tokens are lost
with no metric, no log, no Sentry.

This phase is **staged by design** (the spec says "add a counter FIRST to size it,
then recover"):

1. **Stage A (THIS PR) — MEASURE.** Add a per-tick orphan-drop **counter** on the
   drop branch and register it in `METRIC_KIND_REGISTRY`. Zero behavior change.
   This is the entire deliverable of this PR.
2. **Stage B (DESIGNED HERE, NOT IMPLEMENTED IN THIS PR) — RECOVER.** Re-link
   post-flush continuations so their tokens are summed instead of dropped. Stage B
   carries a real state-machine design choice (status flap / idle-flush re-arm) and
   depends on Phase 4's shrink-guard being in the stack. It is gated on the Stage A
   prod number + operator go-ahead. The full design is in §3.3 so the follow-up is
   ready; **do not write Stage B code in this PR.**

The spec's acceptance criteria explicitly permit this: *"Stage B: post-flush
continuation tokens are counted (**or, if deferred, document why and keep the
counter**)."* (`../phase-05-claude-code-orphan-drop.md` Acceptance criteria.)

**Total surface for THIS PR:** 1 source file (the counter) + 1 registry file +
1 test file. Three changes, all in `proxai_nest`.

---

## 1. Hard rules (non-negotiable — enforced by lint/CI/reviewers)

- **No `any`** — not `: any`, `as any`, `Promise<any>`, `Record<string, any>`,
  generic default `= any`, or implicit any, in source **or** `.spec.ts`. Use
  `unknown` + a type guard. If a 3rd-party type forces an any, **stop and report it**,
  don't insert one.
- **No suppression comments** — `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`,
  `eslint-disable`, `oxlint-disable`, `v8 ignore`. Fix the type instead.
- **No "before/after" references** in code/comments/test names. Describe **current**
  behavior only. Name tests by behavior (e.g.
  `it('counts post-flush orphan drops once per tick', …)`), never by mechanics or
  line numbers.
- **Comments explain *why***, not *what*. No banners.
- **No hot-loop metric/log emits.** A per-record `Logger.metric` (or
  `Logger.service.*` / `Logger.process.*`) inside the parse loop is banned — one
  capture full of orphan records would storm the drain and wedge the event loop.
  Accumulate in a local and emit ONCE after the loop. (`ai/rules/observability/logger-import.md`,
  §"Never emit a per-iteration log in a hot loop"; this is the load-bearing
  correction to the spec's "mirror the `:404` metric shape" note — see §3.1.)
- **Register every new metric name.** A `Logger.metric(name, …)` whose `name` is not
  in `METRIC_KIND_REGISTRY` is silently dropped from Grafana/OTLP — no error, no test
  failure. (`ai/rules/observability/metric-kind-registry.md`.)
- **No hardcoded enum-string values.** N/A here (the labels `post_flush` /
  `pre_first_prompt` are not Prisma enums — they are bounded metric-label literals,
  which is the established pattern, e.g. the `reason` label at
  `parse-process-chat.service.ts:421`).
- **Package manager: `bun`.** Tests: `bun run test:unit <path>` (never raw `vitest`).
  Typecheck: `bun run typecheck`. Do **not** run `bun run validate` while iterating.
- **Git:** do **not** commit/push/branch/stage unless the operator tells you to.
  Leave edits in the working tree.

---

## 2. The mental model — READ THIS BEFORE WRITING CODE

### 2.1 How a Claude Code turn is keyed

A Claude Code "turn" = one `promptId`. **Only `user` records carry a `promptId`**;
**assistant and `tool_result` records carry none** — they append to the currently
open turn via `parentUuid`. The parser
(`src/agent-gateway/parsers/claude-code/services/claude-code-parse-chat.service.ts:182-224`)
encodes exactly four cases in its per-record branch:

```text
rec has promptId ≠ open  → finalize prior turn, open new turn
rec has promptId = open  → continuation, append
rec has NO promptId, turn open     → continuation (assistant/tool_result), append
rec has NO promptId, NO turn open  → ORPHAN → drop (continue)   ← lines 216-220
```

The last case is the bug. Verified at lines 216-220 (the `continue`):

```ts
        } else if (acc.openPromptId === null) {
          // Pre-first-prompt orphan (rare: assistant noise before any user
          // prompt). Skip — there's no turn to attach it to.
          continue;
        }
```

### 2.2 How idle-flush sets up the orphan-drop (cross-tick)

This is **not** a same-tick bug. It is a cross-tick interaction with the idle-flush
cron. Walk it:

- **Buffering ticks (normal).** A turn `X` is open mid-tool-loop. Each normal tick
  advances the parse-state cursor `last_processed_watermark` to the last seen
  capture (`parseChat` sets `lastSeenWatermark = watermarkEnd` for *every* record,
  including the open turn's, then returns it as `lastProcessedWatermark` —
  `claude-code-parse-chat.service.ts:166-167, 293-294`). The accumulator persists
  `openPromptId: X`, `openCaptureFirstWatermarkStr: W0`.
- **Idle-flush tick (24h quiet).** The cron calls `parseChat(..., { idleFlush: true })`
  → end-of-stream force-finalize (`claude-code-parse-chat.service.ts:236-253`) →
  `flushOpenTurn` emits ACR(X) and **clears the open-turn lineage**, including
  `acc.openPromptId = null` (`:439-444`). It sets `acc.lastEmittedPromptId = X`
  (`:430`). Status → COMPLETED.
- **Resume tick (normal, post-flush continuation).** The user's agent resumes the
  **same** tool-loop. New captures (`W2 > W1`) carry assistant + `tool_result`
  records with **no `promptId`**. Because `acc.openPromptId` is now `null`, `parseChat`
  takes the `iterateChunkRecords` path (NOT replay —
  `claude-code-parse-chat.service.ts:150-157`) over those NEW chunks. Every one of
  them hits the orphan branch (`:216-220`) → **dropped**. All post-flush tokens lost.

Contrast: the only existing nearby metric,
`agent_gateway_parser_partial_turn_reset_total` (`:405`), fires on the **defensive
partial-reset** branch inside `flushOpenTurn` (`:393-409`), **not** on the orphan
branch. So the orphan-drop is completely silent today.

### 2.3 Pre-flight watermark assumption — RE-CONFIRMED (acceptance criterion)

The spec (and ROADMAP "Pre-flight findings") assert that idle-flush "advances the
same watermark the main parser reads," so the continuation reads **NEW** post-flush
chunks (the orphan case) rather than re-reading already-processed captures (the
overwrite/F4 case). **Re-confirmed against source, with a wording correction:**

- Idle-flush mode does **not** *strictly advance* the cursor. It replays the existing
  open-turn captures, so `result.lastProcessedWatermark` equals the cursor that was
  **already** advanced to `W1` during the buffering ticks. The UPSERT's cursor
  `CASE WHEN` only advances on a strict `EXCLUDED.last_processed_watermark >
  existing` (`parse-process-chat.service.ts:354-367`); the equal-watermark
  idle-flush path falls into the `ELSE` (cursor **unchanged**), while
  `accumulator_blob` writes unconditionally (the cleared open turn) — documented at
  `parse-process-chat.service.ts:239-260, 290-311`.
- **Net effect (what matters):** the cursor sits at `W1` after idle-flush, so the
  next tick's orchestrator fetches captures with `watermark > W1` (the NEW post-flush
  chunks). With `openPromptId` cleared, that tick uses `iterateChunkRecords` over
  those new chunks → orphan drop. **The pre-flight conclusion holds**: this is the
  "new post-flush chunks / orphan" case, not a re-read/overwrite. Report this nuance
  in your hand-back (the verbatim spec phrase "idle-flush advances the watermark" is
  imprecise; the watermark was advanced during buffering and idle-flush *preserves*
  it — the conclusion is unchanged).

### 2.4 Worked example with real token numbers (so the loss is concrete)

```text
Turn X (one promptId), mid-tool-loop, captured across W0..W1:
  user prompt (promptId=X)                       usage: -
  assistant tool_use  (no promptId)  input=4000  output=120  cache_read=18000
  tool_result         (no promptId)  usage: -
  assistant tool_use  (no promptId)  input=4200  output=110  cache_read=18500
        ── 24h of file-quiet ──
  ── idle-flush fires → ACR(X) emitted with input≈8200 output≈230, openPromptId:=null ──

Resume (new captures W2 > W1), SAME tool-loop continues:
  tool_result         (no promptId)  usage: -                      ← ORPHAN, dropped
  assistant text      (no promptId)  input=4500  output=800  cache_read=19000  ← ORPHAN, dropped
```

Today: the 4500 input + 800 output + 19000 cache_read of the final billed call are
**silently dropped** — the turn under-counts by exactly the post-flush window.
Stage A makes that drop count to `agent_gateway_parser_orphan_dropped_total{agent,
reason="post_flush"}` so prod can size it before Stage B recovers it.

---

## 3. Change spec

### 3.1 CHANGE 1 (Stage A) — orphan-drop counter, accumulate-then-emit-once

**File:** `src/agent-gateway/parsers/claude-code/services/claude-code-parse-chat.service.ts`

> **Critical — do NOT emit inside the loop.** The spec says "mirror the `:404`
> metric shape." That metric (`agent_gateway_parser_partial_turn_reset_total`) is
> emitted from `flushOpenTurn`, which runs **at most O(1) per tick**. The orphan
> branch is **per-record** and can fire thousands of times for one capture full of
> post-flush records. A `Logger.metric(...)` at the drop site would be a hot-loop
> emit — banned by `ai/rules/observability/logger-import.md` (it was a contributing
> factor in the 2026-06-10 parse-stall incident). **Accumulate in a local and emit
> once after the loop**, exactly like the existing bad-line counters do via
> `ExtractorMetricAccumulator`.

#### 3.1.a — declare two per-tick counters

Find the per-tick local block near the top of `parseChat` (verified at
`claude-code-parse-chat.service.ts:121-132`):

```ts
    const acc = this.loadAccumulator(state, chat.agent);
    const emitted: ParsedAgentCallRecord[] = [];
    const metricAccumulator = new ExtractorMetricAccumulator();

    // Per-tick in-memory open-turn record buffer. NOT persisted — the
    // accumulator only carries first-capture lineage.
    let openRecords: ClaudeCodeRecord[] = [];
    let openCaptureLastId: string | null = null;
    let openCaptureLastWatermark: bigint | null = null;

    let lastSeenCaptureId: string | null = null;
    let lastSeenWatermark: bigint | null = null;
```

Insert the two counters immediately after `metricAccumulator`:

```ts
    const acc = this.loadAccumulator(state, chat.agent);
    const emitted: ParsedAgentCallRecord[] = [];
    const metricAccumulator = new ExtractorMetricAccumulator();

    // Per-tick orphan-drop counts — records with no promptId that arrive when
    // no turn is open. Accumulated here and emitted ONCE after the loop: a
    // per-record Logger.metric in the drop branch would be a hot-loop emit (one
    // capture full of post-flush records would storm the drain and add
    // synchronous console.log pressure on the event loop — see
    // ai/rules/observability/logger-import.md). Split by whether a prior turn
    // was ever emitted: `post_flush` is the continuation lost after idle-flush
    // closed its turn (the data-loss path this phase exists to size);
    // `pre_first_prompt` is benign assistant noise before any user prompt.
    let orphanDroppedPostFlush = 0;
    let orphanDroppedPreFirstPrompt = 0;

    // Per-tick in-memory open-turn record buffer. NOT persisted — the
    // accumulator only carries first-capture lineage.
    let openRecords: ClaudeCodeRecord[] = [];
    let openCaptureLastId: string | null = null;
    let openCaptureLastWatermark: bigint | null = null;

    let lastSeenCaptureId: string | null = null;
    let lastSeenWatermark: bigint | null = null;
```

#### 3.1.b — increment in the orphan branch

Find the orphan branch (verified at `claude-code-parse-chat.service.ts:216-220`):

```ts
        } else if (acc.openPromptId === null) {
          // Pre-first-prompt orphan (rare: assistant noise before any user
          // prompt). Skip — there's no turn to attach it to.
          continue;
        }
```

Replace with:

```ts
        } else if (acc.openPromptId === null) {
          // Record carries no promptId and no turn is open → orphan, dropped.
          // Two shapes, distinguished by whether a prior turn was finalized:
          //   - lastEmittedPromptId !== null → a prior turn was finalized and
          //     its open-turn lineage cleared (idle-flush close, or the
          //     defensive partial reset). This is a POST-FLUSH continuation
          //     whose tokens are lost — the dominant idle-flush data-loss path.
          //   - lastEmittedPromptId === null → genuine pre-first-prompt noise
          //     (assistant chatter before any user prompt); nothing to attach.
          if (acc.lastEmittedPromptId !== null) {
            orphanDroppedPostFlush++;
          } else {
            orphanDroppedPreFirstPrompt++;
          }
          continue;
        }
```

#### 3.1.c — emit once, before the existing per-tick flush

Find the existing once-per-tick flush near the end of `parseChat` (verified at
`claude-code-parse-chat.service.ts:288`):

```ts
    metricAccumulator.flush();

    return {
      records: finalRecords,
```

Insert the guarded emits immediately above it:

```ts
    // Emit the per-tick orphan-drop counts ONCE (hot-loop discipline). Guarded
    // on > 0 so a clean tick emits nothing. `agent` is bounded (4 parsers) and
    // `reason` is a 2-value enum, so the series count stays tiny.
    if (orphanDroppedPostFlush > 0) {
      Logger.metric(
        'agent_gateway_parser_orphan_dropped_total',
        orphanDroppedPostFlush,
        { agent: chat.agent, reason: 'post_flush' },
      );
    }
    if (orphanDroppedPreFirstPrompt > 0) {
      Logger.metric(
        'agent_gateway_parser_orphan_dropped_total',
        orphanDroppedPreFirstPrompt,
        { agent: chat.agent, reason: 'pre_first_prompt' },
      );
    }

    metricAccumulator.flush();

    return {
      records: finalRecords,
```

> **DECISION (flagged for the reviewer): emit on the normal-completion path only,
> not on the `CaptureEvictedError` error path.** There is a second
> `metricAccumulator.flush()` on the eviction error path
> (`claude-code-parse-chat.service.ts:226-232`). I deliberately do **not** add the
> orphan emit there. Reason: the orphan branch requires `acc.openPromptId === null`,
> but the eviction error originates inside `iterateReplayedRecords`, which only runs
> when `openPromptId` is **set** (replay mode) — so the orphan branch effectively
> cannot fire on the path that throws `CaptureEvictedError`. Adding a second emit
> site would be dead-shaped code. If a future refactor makes the orphan branch
> reachable mid-replay, revisit. Net gap: negligible and bounded (eviction is rare);
> acceptable for a sizing counter. (`Logger` is already imported at
> `claude-code-parse-chat.service.ts:38` — no new import needed.)

That is the **entire** Stage A source change to this file. Do not touch
`flushOpenTurn`, the replay iterators, the dedup pass, or the accumulator shape.

### 3.2 CHANGE 2 (Stage A) — register the metric

**File:** `src/telemetry/metric-kind-registry.ts`

The new name `agent_gateway_parser_orphan_dropped_total` is a monotonic count of
dropped records (`_total` suffix → counter). It is NOT in the registry today
(verified by grep — only `agent_gateway_parser_cursor_agent_kv_orphan_total` and
`agent_orchestration_runs_orphaned_total` exist). Add it **alphabetically** inside
the `// --- agent_gateway ---` block, between
`agent_gateway_parser_open_turn_replay_truncated_total` (`:159`) and
`agent_gateway_parser_partial_turn_reset_total` (`:160`).

Find:

```ts
    agent_gateway_parser_open_turn_replay_truncated_total: 'counter',
    agent_gateway_parser_partial_turn_reset_total: 'counter',
```

Replace with:

```ts
    agent_gateway_parser_open_turn_replay_truncated_total: 'counter',
    // Per-tick count of promptId-less records dropped because no turn was open
    // (accumulated then emitted once per tick); reason ∈ {post_flush,
    // pre_first_prompt}. `post_flush` sizes the idle-flush continuation loss.
    agent_gateway_parser_orphan_dropped_total: 'counter',
    agent_gateway_parser_partial_turn_reset_total: 'counter',
```

> Label discipline: the `reason` key is a bounded 2-value enum and `agent` is
> bounded (4 parsers). Neither is on `METRIC_LABEL_DENYLIST`
> (`metric-kind-registry.ts:335-353`), so both survive into the metric attributes —
> which is what we want for the `post_flush` vs `pre_first_prompt` split. Do NOT add
> `chat_id` / `user_id` / `host_id` as labels (high-cardinality; denylisted anyway).

### 3.3 Stage B — DESIGNED, NOT IMPLEMENTED IN THIS PR (DECISION, flagged for reviewer)

> **DECISION (flagged for the reviewer): SHIP STAGE A IN THIS PR; DEFER STAGE B to a
> fast-follow gated on (a) the Stage A prod number and (b) operator go-ahead with
> Phase 4 confirmed in the stack.** Do **not** write Stage B code in this PR.
>
> **Why defer (not gold-plating, not half-doing):**
> 1. The spec stages it by design ("add a counter FIRST to size it, then either…")
>    and the acceptance criteria explicitly allow deferral with documentation.
> 2. Stage B is a real state-machine design choice (re-opening a closed turn flips
>    the chat back to ACTIVE and re-arms the idle-flush cron) — the global rule is
>    "when a fix has a real design choice, write a 2-3 option plan and wait for go."
> 3. The only **correct** Stage B requires Phase 4's shrink-guard in the stack
>    (Phase 5 stacks on Phase 4 per ROADMAP "Decisions LOCKED" §4). Without it, the
>    naive re-link **loses data** (proof in Option B3 below). Sizing first avoids
>    paying that complexity if `post_flush` turns out to be a small population.

The design below is provided so the follow-up is a copy-paste job once the operator
says go. It is **out of scope for this PR**.

**Option B1 — RECOMMENDED: re-link via preserved lineage + deferred replay re-emit.**
- When `flushOpenTurn` finalizes a turn, copy the *just-closed* turn's first-capture
  lineage into NEW, additive accumulator fields before clearing the open-turn
  lineage — e.g. `lastFlushedTurnId`, `lastFlushedFirstCaptureId`,
  `lastFlushedFirstWatermarkStr` (`lastEmittedPromptId` already exists at
  `claude-code-parse-chat.service.ts:75`).
- In `parseChat`, when an orphan arrives (`no promptId` && `openPromptId === null`)
  **and** `acc.lastFlushedTurnId !== null`, RE-OPEN that turn by restoring
  `acc.openPromptId = lastFlushedTurnId`, `acc.openCaptureFirstId =
  lastFlushedFirstCaptureId`, `acc.openCaptureFirstWatermarkStr =
  lastFlushedFirstWatermarkStr`. Do **not** finalize in this tick — let the normal
  defer-finalization persist the re-opened lineage. The orphan records read this
  tick (via `iterateChunkRecords`) are discarded at tick end; the **next** tick takes
  the replay path from the preserved first watermark and re-materializes the FULL
  turn (`W0..W1` + post-flush), re-finalizing it into **one** ACR with the **same**
  `deterministicRecordId(agent, chatId, lastFlushedTurnId)` → idempotent UPDATE with
  the fuller token sum. Phase 4's shrink-guard accepts it (full ≥ original).
- **Accumulator change is ADDITIVE — do NOT bump `ACCUMULATOR_VERSION`** (it is `2`
  at `claude-code-parse-chat.service.ts:66`). Old blobs load the new fields as `null`
  via `loadAccumulator` (`:548-557`). Same rationale as Phase 2's Codex anchor: a
  version bump resets every active session's accumulator on deploy, discarding
  in-flight open-turn lineage.
- **No duplicate turns:** the re-emit reuses the original deterministic id; the
  upsert's `ON CONFLICT (id) DO UPDATE` (`parse-batch-upsert.service.ts:504`) updates
  the one row. The intra-tick dedup-by-id (`claude-code-parse-chat.service.ts:273-286`)
  and the batch dedup (`parse-batch-upsert.service.ts:208-228`) both already collapse
  same-id emits.
- **Tradeoff (the design choice to flag):** re-opening sets `hasOpenTurn = true` →
  status flips ACTIVE and re-arms idle-flush after another 24h quiet. This is
  *correct* (a genuine continuation IS new in-flight work) and self-heals: the next
  promptId boundary or idle-flush re-finalizes the now-complete turn → COMPLETED. It
  is NOT a regression of the zombie-strand COMPLETED fix (which targeted chats with
  **no** new data); here there genuinely is new data.

**Option B2 — alternative: carry `openPromptId` across the idle-flush close (don't
clear it).** Simpler, but rejected: it keeps the chat permanently ACTIVE even when
the turn is genuinely done (no continuation ever comes), regressing the
COMPLETED/zombie-strand fix and re-arming idle-flush forever. B1 only re-opens when a
continuation actually arrives, so it self-heals.

**Option B3 — NON-VIABLE trap (documented so nobody ships it): re-link AND finalize
the partial post-flush record set in the detecting tick.** This emits a SHRUNK ACR
(post-flush tokens only). With Phase 4's shrink-guard in the stack → the write is
REJECTED → post-flush tokens still lost. Without Phase 4 → the smaller-window,
higher-watermark write OVERWRITES the original full ACR (`parse-batch-upsert.service.ts:540-545`
gates only on watermark) → original tokens lost. **Either way data is lost. Do not
do this.** The full record set only exists via REPLAY from `W0`, which is why B1
defers the re-emit to the next tick.

---

## 4. Tests (Stage A — `bun run test:unit`, Vitest)

**File:** `src/agent-gateway/parsers/claude-code/services/tests/claude-code-parse-chat.service.spec.ts`

Add the three tests below to the existing top-level `describe('ClaudeCodeParseChatService', …)`
block. They reuse the file's existing helpers — `makeChat`, `makeChunk`, and the
`Logger.metric` spy pattern already used at e.g. `:892`, `:956`, `:1029`. The
imports they need (`Logger`, `AgentParseState`, `Prisma`, `vi`, `describe`, `it`,
`expect`) are already at the top of the file (`:1-11`).

```ts
  it('counts a post-flush continuation orphan once per tick under reason=post_flush', () => {
    // A turn was previously finalized (lastEmittedPromptId set) and its open
    // lineage cleared (openPromptId null) — the state after an idle-flush close.
    // The continuation captures carry assistant records with NO promptId, so
    // they hit the orphan branch and are dropped; the counter must size them.
    return (async () => {
      const metricSpy = vi
        .spyOn(Logger, 'metric')
        .mockImplementation(() => {});

      const chat = makeChat([
        makeChunk('cap-2', 200n, [
          {
            type: 'assistant',
            uuid: 'a-cont-1',
            parentUuid: 'a-prev',
            sessionId: 'sess-1',
            message: {
              model: 'claude-sonnet-4-5',
              content: [{ type: 'text', text: 'continuation 1' }],
              usage: { input_tokens: 4500, output_tokens: 800 },
            },
          },
          {
            type: 'assistant',
            uuid: 'a-cont-2',
            parentUuid: 'a-cont-1',
            sessionId: 'sess-1',
            message: {
              model: 'claude-sonnet-4-5',
              content: [{ type: 'text', text: 'continuation 2' }],
              usage: { input_tokens: 200, output_tokens: 40 },
            },
          },
        ]),
      ]);

      const state = {
        accumulatorBlob: {
          v: 2,
          openPromptId: null,
          openCaptureFirstId: null,
          openCaptureFirstWatermarkStr: null,
          openCaptureLastId: null,
          openCaptureLastWatermarkStr: null,
          lastEmittedPromptId: 'p-prev',
        } as Prisma.JsonValue,
      } as unknown as AgentParseState;

      const result = await service.parseChat(state, chat, '1.0.0');

      // Both continuations are dropped — nothing re-attaches them (Stage A is
      // measure-only).
      expect(result.records).toEqual([]);

      const orphanMetric = metricSpy.mock.calls.find(
        ([name]) => name === 'agent_gateway_parser_orphan_dropped_total',
      );
      expect(orphanMetric).toBeDefined();
      expect(orphanMetric?.[1]).toBe(2);
      expect(orphanMetric?.[2]).toEqual({
        agent: 'CLAUDE_CODE',
        reason: 'post_flush',
      });
    })();
  });

  it('counts a pre-first-prompt orphan under reason=pre_first_prompt', () => {
    // Cold start (no prior turn): assistant noise arrives before any user
    // prompt. Dropped, and counted under the benign pre_first_prompt label.
    return (async () => {
      const metricSpy = vi
        .spyOn(Logger, 'metric')
        .mockImplementation(() => {});

      const chat = makeChat([
        makeChunk('cap-1', 100n, [
          {
            type: 'assistant',
            uuid: 'a-orphan',
            sessionId: 'sess-1',
            message: { content: [{ type: 'text', text: 'orphan reply' }] },
          },
        ]),
      ]);

      const result = await service.parseChat(null, chat, '1.0.0');

      expect(result.records).toEqual([]);

      const orphanMetric = metricSpy.mock.calls.find(
        ([name]) => name === 'agent_gateway_parser_orphan_dropped_total',
      );
      expect(orphanMetric).toBeDefined();
      expect(orphanMetric?.[1]).toBe(1);
      expect(orphanMetric?.[2]).toEqual({
        agent: 'CLAUDE_CODE',
        reason: 'pre_first_prompt',
      });
    })();
  });

  it('does not count an orphan when a fresh prompt opens its own turn', () => {
    // Regression guard: after a prior turn, a NEW user record (new promptId)
    // opens its own turn — it is NOT an orphan, so no counter fires. A trailing
    // assistant appends to the freshly opened turn (also not an orphan).
    return (async () => {
      const metricSpy = vi
        .spyOn(Logger, 'metric')
        .mockImplementation(() => {});

      const chat = makeChat([
        makeChunk('cap-2', 200n, [
          {
            type: 'user',
            uuid: 'u-new',
            sessionId: 'sess-1',
            promptId: 'p-new',
            message: { content: 'a brand new prompt' },
          },
          {
            type: 'assistant',
            uuid: 'a-new',
            parentUuid: 'u-new',
            sessionId: 'sess-1',
            message: {
              model: 'claude-sonnet-4-5',
              content: [{ type: 'text', text: 'reply' }],
              usage: { input_tokens: 10, output_tokens: 5 },
            },
          },
        ]),
      ]);

      const state = {
        accumulatorBlob: {
          v: 2,
          openPromptId: null,
          openCaptureFirstId: null,
          openCaptureFirstWatermarkStr: null,
          openCaptureLastId: null,
          openCaptureLastWatermarkStr: null,
          lastEmittedPromptId: 'p-prev',
        } as Prisma.JsonValue,
      } as unknown as AgentParseState;

      const result = await service.parseChat(state, chat, '1.0.0');

      // p-new is buffered as the open turn (finalized only on the next
      // boundary), so no record emits this tick — and crucially, no orphan.
      const acc = result.accumulator as unknown as {
        openPromptId: string | null;
      };
      expect(acc.openPromptId).toBe('p-new');

      const orphanMetric = metricSpy.mock.calls.find(
        ([name]) => name === 'agent_gateway_parser_orphan_dropped_total',
      );
      expect(orphanMetric).toBeUndefined();
    })();
  });
```

> Note on the `return (async () => { … })()` shape: it matches what some specs in
> this file already do; a plain `async () => { … }` test body is equally fine if you
> prefer — match whichever the surrounding tests use. Do not introduce `any`; the
> `as unknown as AgentParseState` and `as Prisma.JsonValue` casts mirror the existing
> tests verbatim (`:407`, `:838`, `:993`).

The existing test `'drops assistant records that arrive before the first prompt'`
(`:761-788`) stays green unchanged — it asserts `result.records` and `openPromptId`,
not the metric, and the new counter only *adds* a `Logger.metric` call.

---

## 5. Execution order & commands

1. Edit `src/agent-gateway/parsers/claude-code/services/claude-code-parse-chat.service.ts`
   (§3.1.a → §3.1.c).
2. Edit `src/telemetry/metric-kind-registry.ts` (§3.2).
3. Add the three tests (§4).
4. Run (from the repo root, do NOT run `bun run validate` while iterating):
   ```bash
   bun run typecheck
   bun run test:unit src/agent-gateway/parsers/claude-code/services/tests/claude-code-parse-chat.service.spec.ts
   bun run test:unit src/telemetry/tests/metric-kind-registry.spec.ts
   ```
   The metric-registry spec (`src/telemetry/tests/metric-kind-registry.spec.ts`)
   validates registry shape — run it to confirm the new entry doesn't break it.

If any command fails, fix the cause — never silence it with a suppression or an `any`.

---

## 6. Audit / self-check before hand-back

```bash
# 1. The orphan branch now counts instead of silently dropping, and the emit is
#    AFTER the loop (not inside it).
grep -n "orphanDroppedPostFlush\|orphanDroppedPreFirstPrompt\|agent_gateway_parser_orphan_dropped_total" \
  src/agent-gateway/parsers/claude-code/services/claude-code-parse-chat.service.ts
#    → expect: 2 increments inside the else-if branch; 2 guarded Logger.metric
#      emits located just above `metricAccumulator.flush();` (NOT between the
#      `for await` and the loop body).

# 2. No per-record Logger.metric was added inside the loop (hot-loop ban).
grep -n "Logger.metric" src/agent-gateway/parsers/claude-code/services/claude-code-parse-chat.service.ts
#    → the new emits must sit after the loop, alongside the pre-existing
#      end-of-tick flush — not within the `for await (...)` body.

# 3. The metric name is registered.
grep -n "agent_gateway_parser_orphan_dropped_total" src/telemetry/metric-kind-registry.ts
#    → expect exactly one entry, value 'counter', between the open_turn_replay_*
#      and partial_turn_reset entries.

# 4. No behavior change to finalize / re-link landed (Stage A is measure-only).
grep -n "lastFlushedTurnId\|lastFlushedFirstWatermark" \
  src/agent-gateway/parsers/claude-code/services/claude-code-parse-chat.service.ts
#    → expect NOTHING (those belong to Stage B, which is out of scope here).

# 5. No new `any` / suppression slipped in.
grep -nE ": any|as any|@ts-(ignore|expect-error|nocheck)|eslint-disable|oxlint-disable|v8 ignore" \
  src/agent-gateway/parsers/claude-code/services/claude-code-parse-chat.service.ts \
  src/agent-gateway/parsers/claude-code/services/tests/claude-code-parse-chat.service.spec.ts
#    → expect NOTHING.
```

---

## 7. Hand-back report (send this back to the orchestrator / verifier)

1. **Files changed** (path + one line each): the parse-chat service (counter), the
   metric registry (registration), the parse-chat spec (3 tests).
2. **The source diff** for `claude-code-parse-chat.service.ts` and the one-line
   registry add, pasted verbatim.
3. **Test results**: paste the green output of the two `bun run test:unit` commands
   and `bun run typecheck`.
4. **Pre-flight watermark assumption — RE-CONFIRMED** (acceptance criterion). State:
   "Idle-flush does not strictly advance the cursor; the cursor was already at the
   open turn's last watermark from buffering ticks and idle-flush preserves it
   (equal-watermark `ELSE` branch, `parse-process-chat.service.ts:354-367`). Net
   effect: the next tick reads NEW post-flush chunks via `iterateChunkRecords` →
   orphan drop (the orphan case, not the overwrite case). Spec wording 'advances'
   is imprecise; conclusion unchanged."
5. **Stage B status**: DEFERRED with documented design (§3.3, Option B1 recommended).
   State that the counter is shipped to size the `post_flush` population first, and
   that Stage B is gated on the prod number + operator go-ahead + Phase 4 in the
   stack.
6. **Confirm** you did NOT touch: `flushOpenTurn`, the replay iterators,
   `aggregateUsage`, `finalizeTurn`, `build-scalar-spine.ts`,
   `parse-batch-upsert.service.ts`, the accumulator shape / `ACCUMULATOR_VERSION`, or
   any schema/migration.
7. **Anything you could not do without an `any`/suppression** — name the exact type
   friction instead of working around it.

---

## 8. Acceptance criteria (the verifier checks all — mirrors the spec, made concrete)

- [ ] **Pre-flight watermark assumption re-confirmed in-PR** — §2.3 + hand-back item 4.
- [ ] **Stage A counter live + registered** — `agent_gateway_parser_orphan_dropped_total`
      emitted from the orphan branch (accumulated, emitted once per tick) AND present
      in `METRIC_KIND_REGISTRY` as `'counter'`.
- [ ] **Stage B documented as deferred** — §3.3 records why (spec stages it; correct
      recovery needs Phase 4; real status-flap design choice) and the counter is kept.
      (Spec allows: "or, if deferred, document why and keep the counter.")
- [ ] **No duplicate turns; no regression for fresh-prompt continuations** — Stage A
      adds only a counter (zero behavior change); the regression test in §4 proves a
      fresh promptId still opens its own turn with no orphan emit.
- [ ] **Tests green** — the 3 new tests + the existing parse-chat suite + the
      metric-registry spec all pass; `typecheck` passes.
- [ ] **Hot-loop discipline honored** — the metric is emitted once per tick after the
      loop, not per record (verified by audit grep #2).

---

## 9. Out of scope (do NOT do these) + cross-phase dependencies

- **Do NOT implement Stage B (re-link / lineage carry-over) in this PR.** It is
  designed in §3.3 and gated on the Stage A measurement + operator go + Phase 4. The
  spec explicitly stages the counter first.
- **Do NOT** modify `flushOpenTurn`, the open-turn replay (`iterateReplayedRecords` /
  `openTurnReplay`), `aggregateUsage`, `finalizeTurn`, the shared
  `build-scalar-spine.ts`, or `parse-batch-upsert.service.ts`. The shrink-guard on
  the upsert is **Phase 4's** job (`../phase-04-upsert-shrink-guard.md`).
- **Do NOT** bump `ACCUMULATOR_VERSION` or add accumulator fields in this PR (those
  belong to Stage B).
- **Do NOT** touch the Codex / Gemini / Cursor / Claude-Desktop parsers, or the
  idle-flush cron / orchestrator. This PR is one parser's measurement path only.
- **Do NOT** change any schema/migration — there is none in this phase.

**Cross-phase dependencies:**
- **Phase 4 (upsert shrink-guard)** must be in the stack before Stage B ships — it is
  the defense-in-depth that makes the Option-B1 re-emit safe (and that makes the
  Option-B3 trap merely a no-op rejection rather than a corruption). Phase 5 stacks on
  Phase 4 per ROADMAP "Decisions LOCKED" §4.
- **Phase 7 (Claude Desktop)** is blocked on this phase (it reuses the Claude Code
  parser); your Stage A change is on the shared CC parse path, so Desktop inherits the
  counter automatically once Phase 7 routes Desktop through it.
- **Phase 11 (backfill)** recovers the historically-dropped continuations: they ARE in
  S3 (the drop is in nest, post-upload — ROADMAP backfillability table marks F4
  orphan-drop "✅ yes — re-parse"). Re-parse recovers them once Stage B lands. Nothing
  for you to do here beyond shipping the counter.
