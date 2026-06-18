# Phase 6 — Implementation Instructions (for the implementer model)

> **Audience:** the small/fast implementer model that will write the code.
> **Author:** orchestrator chat (source-verified against `proxai_nest` on 2026-06-17).
> **Companion specs (already settled — do not re-open):**
> `../phase-06-codex-reattach-guard.md`, `../ROADMAP.md`,
> `../analysis/VERIFICATION_FINDINGS.md` §11.2, `../analysis/IMPLEMENTATION_PLAN.md` Rank 6.
>
> Everything you need is here. Every path/line/snippet below was read from the
> actual source. **Follow it literally.** If line numbers have drifted, trust the
> *named symbol* (function/interface/field name), not the line number.
>
> **This phase is `proxai_nest` ONLY.** No gateway change. No schema/migration
> change. No queue change. No token-math change.

---

## 0. TL;DR — what you are doing

Codex **re-emits** `task_started{X}` for a turn it already finalized into a
record. The Codex parser's duplicate-`task_started` guard only catches the case
where that turn is **still open** (`acc.openTurnId === X`). After a turn is
flushed, `acc.openTurnId` is cleared to `null`, so a *post-flush* re-emit of
`task_started{X}` slips past the guard and **opens a fresh turn with the same
`X`**. That fresh turn sees only the post-flush `token_count` events (a smaller
token window), produces the **same deterministic record id** with a **higher
capture watermark**, and the shared watermark-gated upsert overwrites the
original (larger) record → **under-count**.

The fix is one extra guard clause: **also drop (and count) a `task_started`
whose turn id equals `acc.lastEmittedTurnId`** — i.e. a turn we already emitted.

**Files you will touch (all in `proxai_nest`):**
1. `src/agent-gateway/parsers/codex/services/codex-parse-chat.service.ts` — add the guard clause + emit the drop metric.
2. `src/telemetry/metric-kind-registry.ts` — register the new metric as a `counter`.
3. `src/agent-gateway/parsers/codex/tests/codex-parse-chat.service.spec.ts` — 3 tests (single-tick drop, cross-tick drop, in-open-turn regression).

**Total surface:** 1 source file (the guard) + 1 registry line + 1 spec file.
Roughly ~12 lines of product code.

---

## 1. Hard rules (non-negotiable — enforced by lint/CI/reviewers)

- **No `any`** — not `: any`, `as any`, `Promise<any>`, `Record<string, any>`,
  generic default `= any`, or implicit any, in source **or** `.spec.ts`. Use
  `unknown` + a type guard at boundaries. If a 3rd-party type forces an any,
  **stop and report it** — do not insert one.
- **No suppression comments** — `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`,
  `eslint-disable`, `oxlint-disable`, `v8 ignore`. Fix the type instead.
- **No "before/after" references** in code, comments, or test names. Describe
  **current** behavior only. A test name says what the code does now
  (`it('drops a re-emitted task_started for an already-emitted turn', …)`), never
  "no longer opens" / "used to overwrite".
- **Comments explain *why***, not *what*. No decorative banners.
- **No hardcoded enum-string values.** (Not relevant to this phase's edits — the
  one string literal you add is the metric NAME, which lives at exactly one place
  and is registered in the registry; that is the metric convention, not an enum.)
- **Package manager: `bun`.** Tests: `bun run test:unit <path>` (never raw
  `vitest`). Typecheck: `bun run typecheck`. Do **not** run `bun run validate`
  while iterating.
- **Git:** do **not** commit/push/branch/stage unless the operator tells you to.
  Leave edits in the working tree. The operator owns the branch + PR.

---

## 2. The mental model — READ THIS BEFORE WRITING CODE

### 2.1 How a Codex turn becomes a record

`CodexParseChatService.parseChat` (`codex-parse-chat.service.ts:132-363`) streams
the rollout JSONL and assembles one `ParsedAgentCallRecord` per **turn**. A turn
opens on `task_started{X}` and closes on `task_complete{X}` or `turn_aborted{X}`
(or is force-closed by the idle-flush cron). On close, `flushOpenTurn`
(`:447-525`) finalizes the turn and, **only when a record is actually emitted**,
advances `acc.lastEmittedTurnId = acc.openTurnId` (`:498`) and then **clears**
the open lineage: `acc.openTurnId = null` (`:520`).

The accumulator (`CodexAccumulator`, `:83-92`) is **persisted JSONB across
ticks**. Its two fields that matter here:
- `openTurnId: string | null` — the turn currently being assembled; `null` after a flush.
- `lastEmittedTurnId: string | null` — the last turn that produced a record; the parent-id anchor.

### 2.2 The existing duplicate guard (and the gap)

`codex-parse-chat.service.ts:229-242`, inside the `task_started` branch:

```ts
        const evType = eventMsgType(line);
        if (evType === 'task_started') {
          const newTurnId = lineTurnId(line);
          if (!newTurnId) continue;

          // Same turn_id repeating: ignore. Codex re-emits task_started
          // on some retry / re-attach flows; treating it as a fresh
          // open would discard buffered lines.
          if (acc.openTurnId === newTurnId) {
            metricAccumulator.recordEvent(
              'agent_gateway_parser_duplicate_task_started_total',
              { agent: 'CODEX' },
            );
            continue;
          }
```

This guard fires only when the re-emitted turn is **still the open turn**. After
a flush, `acc.openTurnId` is `null`, so `null === newTurnId` is **false** and the
re-emit falls through to the "different turn while one is open → finalize +
open fresh" path (`:244-274`), which sets `acc.openTurnId = newTurnId` and starts
a brand-new buffer `openLines = [line]`. That fresh post-flush turn is the bug.

### 2.3 Why the fresh post-flush turn corrupts the original record

Three facts chain together:

1. **Same id.** The record id is deterministic:
   `deterministicRecordId('CODEX', chat.chatId, turnId)` hashes
   `` `${agent}|${chatId}|${turnId}` `` (`parsers.utils.ts:47-58`,
   used at `codex-finalize-turn.service.ts:265`). Re-opening turn `X` re-derives
   the **identical** id → it conflicts with the original record's row.
2. **Smaller token window.** The re-opened turn sees only the `token_count`
   events that arrive *after* the flush (there is **no S3 replay** on re-open —
   replay only runs when `openTurnId` is set on tick entry, `:166-173`), so its
   summed/diffed usage is smaller than the original turn's.
3. **Higher watermark wins the upsert.** The re-emit arrives in a **later**
   capture, so the new row's `last_capture_watermark_end` is **greater** than the
   original's. The shared batch upsert's `DO UPDATE` is gated by
   (`parse-batch-upsert.service.ts:540-545`):
   ```sql
   WHERE
     agent_call_records.last_capture_watermark_end IS NULL
     OR (
       EXCLUDED.last_capture_watermark_end IS NOT NULL
       AND EXCLUDED.last_capture_watermark_end > agent_call_records.last_capture_watermark_end
     )
   ```
   `W_new > W_old` is true → the smaller-token record overwrites the original.

So the original turn's tokens are silently clobbered by a post-flush re-attach.

### 2.4 The fix in one sentence

A `task_started{X}` where `X === acc.lastEmittedTurnId` is a re-attach of a turn
we **already emitted** — drop it (and count it), exactly the way the existing
guard drops a still-open duplicate.

### 2.5 Worked example (the canonical abort case)

```
TICK 1 (capture cap-1, watermark 200):
  session_meta
  task_started{turn-A}
  user_message "do X"
  token_count last_in=18800            ← turn A's real usage
  turn_aborted{turn-A}                 ← flush → ACR(turn-A) emitted (id=H(CODEX|sess|turn-A))
                                          acc.openTurnId=null, acc.lastEmittedTurnId='turn-A'

TICK 2 (capture cap-2, watermark 450):
  task_started{turn-A}                 ← RE-EMIT of an already-emitted turn
  token_count last_in=200              ← a stray post-flush frame (tiny)
```

- **Without the fix:** tick 2 opens a fresh `turn-A`, finalizes a record with the
  tiny post-flush usage and id `H(CODEX|sess|turn-A)` and watermark 450. The
  upsert sees `450 > 200` → overwrites the good ACR with the tiny one. **Under-count.**
- **With the fix:** tick 2's `task_started{turn-A}` matches `acc.lastEmittedTurnId`
  → dropped + counted. The tiny `token_count` then hits `if (acc.openTurnId ===
  null) continue;` (`:278`) and is discarded as pre-first-task noise. **No second
  record; original ACR preserved.**

Population (from VERIFICATION_FINDINGS §11.2): **134 `turn_aborted` + 2
`idle_timeout`** prod Codex flushes are the at-risk set. Gemini is structurally
immune (its truncated/runaway flush drops the offending step rather than
continuing it — `gemini-parse-chat.service.ts`), so this is Codex-specific.

---

## 3. CHANGE 1 — `codex-parse-chat.service.ts` (the guard)

**File:** `src/agent-gateway/parsers/codex/services/codex-parse-chat.service.ts`

### 3.1 Insert the re-attach guard

**Find** this exact block (`:233-244` — the existing dup guard `}` followed by the
"Different turn_id" comment):

```ts
          // Same turn_id repeating: ignore. Codex re-emits task_started
          // on some retry / re-attach flows; treating it as a fresh
          // open would discard buffered lines.
          if (acc.openTurnId === newTurnId) {
            metricAccumulator.recordEvent(
              'agent_gateway_parser_duplicate_task_started_total',
              { agent: 'CODEX' },
            );
            continue;
          }

          // Different turn_id while one is still open (no terminal event)
          // — finalize as best-effort. Truncated turn.
          if (acc.openTurnId !== null && openLines.length > 0) {
```

**Replace with** (the original blocks unchanged; a NEW guard inserted between
them):

```ts
          // Same turn_id repeating: ignore. Codex re-emits task_started
          // on some retry / re-attach flows; treating it as a fresh
          // open would discard buffered lines.
          if (acc.openTurnId === newTurnId) {
            metricAccumulator.recordEvent(
              'agent_gateway_parser_duplicate_task_started_total',
              { agent: 'CODEX' },
            );
            continue;
          }

          // Re-emitted task_started for a turn already finalized into a
          // record. `acc.openTurnId` was cleared on flush, so the guard
          // above can't catch this. Opening it fresh would re-derive the
          // SAME deterministic record id from a post-flush-only line window
          // (no S3 replay on re-open) with a HIGHER capture watermark, and
          // the watermark-gated upsert would overwrite the original record
          // with that smaller token sum. Drop it: the original record
          // already covers this turn, and a cold-start re-parse is the only
          // correct way to re-derive it.
          if (acc.lastEmittedTurnId === newTurnId) {
            metricAccumulator.recordEvent(
              'agent_gateway_parser_reattach_dropped_total',
              { agent: 'CODEX' },
            );
            continue;
          }

          // Different turn_id while one is still open (no terminal event)
          // — finalize as best-effort. Truncated turn.
          if (acc.openTurnId !== null && openLines.length > 0) {
```

That is the entire source change in this file. Notes:

- **Type-safe.** `acc.lastEmittedTurnId` is `string | null`; `newTurnId` is
  `string` (we already returned via `if (!newTurnId) continue;` at `:231`). The
  strict `===` is safe with no cast and no `any`.
- **`metricAccumulator` is in scope** — it is created at the top of `parseChat`
  (`:140`) and flushed once at end-of-tick (`:354`), so the per-tick accumulation
  contract is preserved (see §3.3).
- **Order is load-bearing.** The existing `openTurnId === newTurnId` check stays
  **first** so a *still-open* duplicate keeps emitting
  `agent_gateway_parser_duplicate_task_started_total` (the regression in §4.3).
  The two conditions are mutually exclusive in practice — after a flush
  `openTurnId` is `null` and `lastEmittedTurnId` is the flushed id — but keeping
  the open-turn check first guarantees the two metrics never blur.

> **DECISION (flagged for reviewer) — drop, not alarm.** The phase spec says
> "ALSO ignore (**or alarm on**)". Recommendation: **drop + count** (the chosen
> shape above), NOT throw/PARSE_FAILED. Throwing would mark the whole chat's
> parse-state `PARSE_FAILED` over a benign, expected re-emit (134+2 prod
> occurrences), turning a self-healing no-op into an operational alert storm. The
> counter is the alarm: `increase(agent_gateway_parser_reattach_dropped_total)`
> sizes the abort-replay population and a Grafana panel/alert can be wired on it
> without any code-path change. If the reviewer wants a hard alarm, escalate —
> do not switch to a throw silently.

> **DECISION (flagged for reviewer) — gate on `lastEmittedTurnId` (emitted turns
> only), by design.** `lastEmittedTurnId` is advanced at `:498` *only when
> `finalized !== null`* — i.e. only for turns that actually wrote a record. A
> turn that flushed but was **dropped** (synthetic/empty, `finalized === null`)
> does not set `lastEmittedTurnId`, so its re-emit is NOT caught by this guard —
> and that is correct: there is no original record to protect, so re-opening it is
> harmless (it produces a real record now or is dropped again). Do not "improve"
> this by also tracking dropped-turn ids.

### 3.2 Do NOT change anything else in this file

- Do **not** touch `flushOpenTurn`, the replay iterators, `loadAccumulator`, the
  accumulator shape, or `ACCUMULATOR_VERSION` (stays `2`). The guard reads an
  existing field; nothing new is persisted.
- Do **not** move or alter the existing `agent_gateway_parser_duplicate_task_started_total`
  emit.
- Do **not** add S3 replay on re-open (the spec explicitly notes the re-open has
  no replay; we are *preventing* the re-open, not feeding it).

### 3.3 Why `recordEvent` (not `Logger.metric`) — hot-loop discipline

The guard sits inside the per-line `for await` loop. Per
`ai/rules/observability/logger-import.md` ("Never emit a per-iteration log in a
hot loop"), a per-line `Logger.metric(..., 1, ...)` could storm the drain on a
pathological capture. `ExtractorMetricAccumulator.recordEvent(metric, labels)`
(`field-extractor.ts:121-132`) accumulates by `metric|labels` and is flushed
**once** per tick by the existing `metricAccumulator.flush()` call (`:354`),
which emits one `Logger.metric(name, count, labels)` line. This is exactly the
shape the existing `agent_gateway_parser_duplicate_task_started_total` uses —
match it.

---

## 4. CHANGE 2 — register the metric in `metric-kind-registry.ts`

**File:** `src/telemetry/metric-kind-registry.ts`

A metric name not present in `METRIC_KIND_REGISTRY` is **silently dropped** from
the OTLP/Grafana pipeline (`otel-init.ts` `recordMetric` returns early on an
unknown name — see `ai/rules/observability/metric-kind-registry.md`). It still
reaches stdout but never becomes a Prometheus series, with **no error and no test
failure**. So registration is mandatory.

### 4.1 Add the registry entry (alphabetical, `counter`)

**Find** (inside the `// --- agent_gateway ---` block, `:161-162`):

```ts
    agent_gateway_parser_provider_inferred_total: 'counter',
    agent_gateway_parser_replay_filtered_other_composer_total: 'counter',
```

**Replace with**:

```ts
    agent_gateway_parser_provider_inferred_total: 'counter',
    // Verified: a re-emitted task_started for an already-emitted Codex turn was
    // dropped by the re-attach guard. Monotonic count of drops, accumulated per
    // tick → counter. Sizes the abort/idle-flush re-attach population.
    agent_gateway_parser_reattach_dropped_total: 'counter',
    agent_gateway_parser_replay_filtered_other_composer_total: 'counter',
```

`reattach` sorts before `replay` (`rea` < `rep`), so this is the alphabetically
correct slot. Kind is `counter` (`_total` suffix, monotonic). No
`METRIC_LABEL_DENYLIST` change is needed — the only label is `agent` (bounded, 4
parsers).

> **DECISION (flagged for reviewer) — metric name.** Chosen:
> `agent_gateway_parser_reattach_dropped_total`. It parallels the sibling
> `agent_gateway_parser_duplicate_task_started_total`, is grep-able, and the
> `_total` suffix matches the counter convention. If the reviewer prefers an even
> more explicit name (e.g. `agent_gateway_parser_emitted_turn_reattach_dropped_total`),
> change it in BOTH the source emit (§3.1) and the registry line (§4.1) together —
> a mismatch silently drops the series.

### 4.2 The completeness test does not catch a missing registration

`src/telemetry/tests/metric-kind-registry.spec.ts` validates the registry's
internal shape but does **not** scan producer call-sites. So a missing entry
passes typecheck, lint, AND that spec — the only signal is "the dashboard panel is
empty." This is why §4.1 is a required step, not optional. (No edit to that spec
is needed; just confirm it still passes.)

---

## 5. CHANGE 3 — Tests

**File:** `src/agent-gateway/parsers/codex/tests/codex-parse-chat.service.spec.ts`
**Runner:** `bun run test:unit <path>` (Vitest).

The spec already provides every helper you need (read `:14-142`): `meta()`,
`event()`, `ri()`, `turnLines()`, `makeChunk()`, `makeChat()`, `makeService()`,
plus `PARSER_VERSION`. Re-use them. Add this new `describe` block at the end of
the file. The metric assertions spy on `console.log` (the sink for
`Logger.metric`, flushed by `metricAccumulator.flush()` at end-of-tick) — exactly
the pattern the existing accumulator-reset test uses (`:743-773`).

```ts
// ─────────────────────────────────────────────────────────────────────────
// Re-attach guard: a re-emitted task_started for an already-emitted turn
// must not open a fresh, smaller-window turn that overwrites the original.
// ─────────────────────────────────────────────────────────────────────────

describe('CodexParseChatService — re-attach guard for already-emitted turns', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    vi.restoreAllMocks();
  });

  function metricHits(name: string): string[] {
    return (logSpy.mock.calls as unknown[][])
      .map((c) => String(c[0]))
      .filter((s: string) => s.includes(name));
  }

  it('drops a re-emitted task_started for a turn already emitted in the same tick', async () => {
    const service = makeService();
    // turn-1 completes (emits a record, clears openTurnId, sets
    // lastEmittedTurnId='turn-1'). Then task_started{turn-1} is re-emitted
    // with a trailing token_count — it must be dropped, not re-opened.
    const bytes =
      meta('sess-1') +
      '\n' +
      turnLines('turn-1', { userText: 'do X', finalText: 'done' }) +
      [
        event({ type: 'task_started', turn_id: 'turn-1', started_at: 9 }),
        event({
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: 3,
              output_tokens: 1,
              cached_input_tokens: 0,
            },
          },
          rate_limits: null,
        }),
      ].join('\n') +
      '\n';
    const chat = makeChat([makeChunk(bytes, 'cap-1', 200n)]);

    const r = await service.parseChat(null, chat, PARSER_VERSION);

    // Exactly one record — the re-emit produced no second smaller-window ACR.
    expect(r.records).toHaveLength(1);
    expect(r.records[0].turnId).toBe('turn-1');
    // The surviving record carries the full turn's usage (the pre-flush
    // token_count: input 10 minus cached 2 = 8), not the tiny re-emit frame.
    expect(r.records[0].result.usage?.input_tokens).toBe(8);
    // The drop is counted; the still-open dup metric is NOT.
    expect(metricHits('agent_gateway_parser_reattach_dropped_total').length)
      .toBeGreaterThan(0);
    expect(metricHits('agent_gateway_parser_duplicate_task_started_total'))
      .toEqual([]);
    // Open lineage stays cleared.
    const acc = r.accumulator as never as { openTurnId: string | null };
    expect(acc.openTurnId).toBeNull();
  });

  it('drops a post-flush re-emitted task_started that arrives in a later tick', async () => {
    const service = makeService();

    // Tick 1: turn-1 completes → record emitted, accumulator carries
    // lastEmittedTurnId='turn-1', openTurnId=null.
    const tick1 =
      meta('sess-1') +
      '\n' +
      turnLines('turn-1', { userText: 'first', finalText: 'A' });
    const chat1 = makeChat([makeChunk(tick1, 'cap-1', 200n)]);
    const r1 = await service.parseChat(null, chat1, PARSER_VERSION);
    expect(r1.records).toHaveLength(1);

    // Tick 2: a later capture re-emits task_started{turn-1} + a stray
    // token_count. session_meta is already pinned in the accumulator.
    const tick2 =
      [
        event({ type: 'task_started', turn_id: 'turn-1', started_at: 50 }),
        event({
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: 4,
              output_tokens: 2,
              cached_input_tokens: 0,
            },
          },
          rate_limits: null,
        }),
      ].join('\n') + '\n';
    const chat2 = makeChat([makeChunk(tick2, 'cap-2', 450n)]);
    const state2 = {
      accumulatorBlob: r1.accumulator,
    } as unknown as AgentParseState;

    const r2 = await service.parseChat(state2, chat2, PARSER_VERSION);

    // No second record; the original ACR is untouched.
    expect(r2.records).toHaveLength(0);
    expect(metricHits('agent_gateway_parser_reattach_dropped_total').length)
      .toBeGreaterThan(0);
    const acc2 = r2.accumulator as never as {
      openTurnId: string | null;
      lastEmittedTurnId: string | null;
    };
    expect(acc2.openTurnId).toBeNull();
    expect(acc2.lastEmittedTurnId).toBe('turn-1');
  });

  it('still ignores a duplicate task_started for the SAME open turn (in-flight retry)', async () => {
    const service = makeService();
    // turn-1 is OPEN (not yet flushed) when task_started{turn-1} repeats:
    // the open-turn dup guard fires; the re-attach guard does NOT.
    const bytes =
      meta('sess-1') +
      '\n' +
      [
        event({ type: 'task_started', turn_id: 'turn-1', started_at: 0 }),
        event({ type: 'user_message', message: 'first' }),
        event({ type: 'task_started', turn_id: 'turn-1', started_at: 1 }),
        ri({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'final' }],
        }),
        event({
          type: 'task_complete',
          turn_id: 'turn-1',
          last_agent_message: 'final',
          completed_at: 2,
        }),
      ].join('\n') +
      '\n';
    const chat = makeChat([makeChunk(bytes, 'cap-1', 50n)]);

    const r = await service.parseChat(null, chat, PARSER_VERSION);

    expect(r.records).toHaveLength(1);
    // First user_message wins — the in-flight duplicate did not reset the buffer.
    expect(r.records[0].query.user_input.content[0]).toMatchObject({
      type: 'TEXT',
      text: 'first',
    });
    expect(metricHits('agent_gateway_parser_duplicate_task_started_total').length)
      .toBeGreaterThan(0);
    expect(metricHits('agent_gateway_parser_reattach_dropped_total')).toEqual([]);
  });
});
```

Notes on the test design:
- The `input_tokens === 8` assertion in the first test is **robust to Phase 2**:
  the `turnLines()` helper's `token_count` carries only `last_token_usage` (no
  `total_token_usage`), so whether `aggregateUsage` sums (current) or diffs
  (Phase 2's cumulative-diff path, which falls back to the legacy sum when no
  `total_token_usage` is present) the value is `10 − 2 = 8`. If you find the
  baseline single-turn test (`:147-172`) asserts a different number after a
  Phase 2 merge, mirror THAT number — do not invent one.
- No prisma/S3 mocking is needed: both ticks enter with `openTurnId === null`, so
  the chunks-only path runs (no replay). `makeService()` defaults suffice.
- Do not assert mock-call counts on prisma — these are unit specs over observable
  outputs (records + emitted metrics + accumulator state).

---

## 6. Execution order & commands

1. Edit `codex-parse-chat.service.ts` (§3.1) — insert the re-attach guard.
2. Edit `metric-kind-registry.ts` (§4.1) — register the counter.
3. Add the test `describe` block (§5).
4. Run:
   ```bash
   bun run typecheck
   bun run test:unit src/agent-gateway/parsers/codex/tests/codex-parse-chat.service.spec.ts
   bun run test:unit src/telemetry/tests/metric-kind-registry.spec.ts
   ```
   Do **not** run `bun run validate` while iterating.

If a command fails, fix the cause — never silence it with a suppression or an
`any`.

---

## 7. Audit / self-check before hand-back

Run these greps in `proxai_nest`:

```bash
# (a) The guard now considers lastEmittedTurnId (orchestrator quick-check).
grep -n "lastEmittedTurnId" \
  src/agent-gateway/parsers/codex/services/codex-parse-chat.service.ts
#  → expect the new `if (acc.lastEmittedTurnId === newTurnId)` guard, plus the
#    pre-existing :498 assignment and the :536 defensive read.

# (b) The drop metric is emitted from the parser AND registered.
grep -rn "agent_gateway_parser_reattach_dropped_total" src/
#  → exactly two hits: the emit in codex-parse-chat.service.ts and the registry
#    line in src/telemetry/metric-kind-registry.ts. No other.

# (c) No accumulator version bump, no schema change.
grep -n "ACCUMULATOR_VERSION" \
  src/agent-gateway/parsers/codex/services/codex-parse-chat.service.ts
#  → still `const ACCUMULATOR_VERSION = 2 as const;` (unchanged).

# (d) You did not touch the upsert, the token math, or other parsers.
git status --short
#  → only codex-parse-chat.service.ts, metric-kind-registry.ts, and the codex
#    parse-chat spec should appear.
```

Confirm the existing duplicate-task_started test (`:664-699`) and the abort test
(`:701-725`) still pass unchanged.

---

## 8. Hand-back report (send this back to the orchestrator/verifier)

1. **Files changed** (path + one line each) — should be exactly 3.
2. **The source diff** for `codex-parse-chat.service.ts` (the new guard) and the
   registry line, pasted verbatim.
3. **Test results**: paste the green output of
   `bun run test:unit src/agent-gateway/parsers/codex/tests/codex-parse-chat.service.spec.ts`,
   the metric-kind-registry spec, and `bun run typecheck`.
4. **Confirm the metric name** you used in the emit matches the registry key
   exactly (`agent_gateway_parser_reattach_dropped_total`, kind `counter`).
5. **Confirm the two flagged decisions** were implemented as written: drop (not
   throw/alarm); gate on `lastEmittedTurnId` (emitted-turns-only, dropped turns
   intentionally not covered).
6. **Confirm you did NOT touch:** `flushOpenTurn`, `ACCUMULATOR_VERSION`, the
   accumulator shape, `parse-batch-upsert.service.ts`, `aggregateUsage`/token
   math, or any non-Codex parser.
7. **Anything you could not do without an `any`/suppression** — name the type
   friction instead of working around it.

---

## 9. Acceptance criteria (the verifier checks all)

- [ ] A re-emitted `task_started` whose id equals `acc.lastEmittedTurnId` is
      dropped — no second, smaller-window record is produced (proved by the
      single-tick and cross-tick tests in §5).
- [ ] The drop metric `agent_gateway_parser_reattach_dropped_total{agent='CODEX'}`
      is emitted (via the per-tick `metricAccumulator`) **and** registered as a
      `counter` in `METRIC_KIND_REGISTRY`.
- [ ] In-open-turn duplicate behavior is unchanged: a duplicate `task_started` for
      the still-open turn still emits
      `agent_gateway_parser_duplicate_task_started_total` and preserves the
      buffered body; the re-attach metric does NOT fire for that case.
- [ ] The original record's tokens are preserved (only one record per emitted
      turn id; the surviving record carries the full-turn usage).
- [ ] `ACCUMULATOR_VERSION` unchanged (`2`); no schema/migration; no upsert change.
- [ ] All new + existing codex parse-chat tests are green; the metric-registry
      spec is green; `typecheck` passes.
- [ ] No `any`, no suppression comments, no before/after references.

---

## 10. Out of scope (do NOT do these) + cross-phase dependencies

**Out of scope:**
- **The upsert shrink-guard is Phase 4, not here.** Phase 6 prevents the
  smaller-window record from being *produced*; Phase 4 hardens
  `parse-batch-upsert.service.ts`'s `WHERE`/`SET` so a shrinking record can't
  overwrite even if one slips through. Do **not** edit
  `parse-batch-upsert.service.ts` in this phase.
- **The Codex token math is Phase 2, not here.** Do **not** touch
  `aggregateUsage`, `readTurnEndCumulative`, the extractors, `codex.utils.ts`, or
  `codex-finalize-turn.service.ts`. The guard is independent of whether usage is
  summed (current) or cumulative-diffed (Phase 2) — leave the math alone.
- **No new schema column, no `ACCUMULATOR_VERSION` bump, no queue/cron change.**
- **Do not touch the Claude Code, Claude Desktop, Gemini, or Cursor parsers**, or
  the shared `build-scalar-spine.ts`. This is Codex-only.
- **Historical correction is Phase 11's job** (re-parse from S3 — the data IS in
  S3, so it is backfillable). You only fix forward logic.

**Cross-phase dependencies (verifier should know):**
- **Depends on Phase 4** (per ROADMAP — Phase 4 is the broad upsert backstop;
  this is the targeted source-side fix). The two are complementary defense-in-depth
  for the same under-count; Phase 6's code change is self-contained and does not
  require Phase 4's code to compile, but the *protection* is layered.
- **Interacts with Phase 2** (Codex cumulative-diff token anchor). If Phase 2 has
  landed first, `parseChat` still threads the token anchor internally; your guard
  and tests are unaffected because they assert record COUNT + the drop metric, and
  the one token assertion uses a `last_token_usage`-only fixture that yields the
  same `8` under both the legacy-sum and cumulative-diff regimes (see §5 note).
- **Phase 11 backfill** depends on this guard being in place so the cold-start
  re-parse re-derives each emitted turn exactly once.
