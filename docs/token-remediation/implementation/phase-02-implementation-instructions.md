# Phase 2 — Implementation Instructions (for the implementer model)

> **Audience:** the small/fast implementer model that will write the code.
> **Author:** orchestrator chat (source-verified against `proxai_nest` on 2026-06-17).
> **Companion specs (already settled — do not re-open):**
> `../phase-02-codex-over-count.md`, `../ROADMAP.md`,
> `../analysis/VERIFICATION_FINDINGS.md` §3, `../analysis/CROSS-SOURCE-NORMALIZATION.md`.
>
> Everything you need is here. Every path/line/snippet below was read from the actual
> source. **Follow it literally.** If line numbers have drifted, trust the *named
> symbol* (function/interface name), not the line number.
>
> **This phase is `proxai_nest` ONLY.** No gateway change. No schema/migration change.

---

## 0. TL;DR — what you are doing

Codex **OVER-counts** input + cache-read tokens (~9% on multi-turn sessions, 1.46B prod
input tokens affected). The parser sums `last_token_usage` across every `token_count`
event in a turn, but Codex **re-emits** frames — at the start of each new turn (re-stating
the prior turn's last call) and on rate-limit-only updates — so those duplicate usages get
added again.

You will replace the blind sum with a **cumulative-total difference**: a turn's tokens =
`total_token_usage(end of turn) − total_token_usage(start of turn)`, where the start anchor
is the **prior turn's final cumulative total**, persisted in the parser's accumulator so it
survives across capture ticks. Because `total_token_usage` is the running session total,
re-emitted frames don't advance it, so they are naturally excluded.

**Files you will touch (all in `proxai_nest`):**
1. `src/agent-gateway/parsers/codex/codex.utils.ts` — the math (the core change).
2. `src/agent-gateway/parsers/codex/services/codex-finalize-turn.service.ts` — thread the anchor in.
3. `src/agent-gateway/parsers/codex/services/codex-parse-chat.service.ts` — persist + update the anchor.
4. `src/agent-gateway/parsers/codex/extractors/usage.ts` — fix the stale docstring + the fallback call.
5. Tests under `src/agent-gateway/parsers/codex/tests/` — rewrite the old "SUMS" test, add 6 new
   unit cases (A–F, §7.1), update 3 enumerated existing tests (§7.1.1), and add the required
   parse-chat multi-turn anchor test (§7.3).

---

## 1. Hard rules (non-negotiable — enforced by lint/CI/reviewers)

- **No `any`** — not `: any`, `as any`, `Promise<any>`, `Record<string, any>`, or implicit
  any, in source **or** `.spec.ts`. Use `unknown` + narrowing. If a 3rd-party type forces an
  any, **stop and report it**, don't insert one.
- **No suppression comments** — `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`,
  `eslint-disable`, `oxlint-disable`, `v8 ignore`. Fix the type instead.
- **No "before/after" references** in code/comments/test names. Describe **current** behavior
  only. A new or rewritten test name says what the code does now (e.g.
  `it('computes a turn as total_token_usage(end) minus the prior-turn anchor', …)`), never
  "no longer sums" / "used to sum".
- **Comments explain *why***, not *what*. No banners.
- **Package manager: `bun`.** Tests: `bun run test:unit <path>` (never raw `vitest`).
  Typecheck: `bun run typecheck`. Do **not** run `bun run validate` while iterating.
- **Git:** do **not** commit/push/branch/stage unless the operator tells you to. Leave edits
  in the working tree.
- **No `any` in the accumulator either** — the new field is a typed `TokenUsageBlock | null`.
- **Ship only the why-comments.** Every snippet below carries only comments meant for the final
  source — the `readTurnEndCumulative` docstring, the `aggregateUsage` docstring, the
  accumulator-field docstring, and the flush-anchor `//` block. The snippets contain **no**
  authoring/annotation tags. If you ever see a trailing tag on a line that describes a prior
  state of the code, it is not source — never paste it.

---

## 2. The mental model — READ THIS BEFORE WRITING CODE

### 2.1 What Codex emits

Each `token_count` event carries two token blocks (`TokenCountPayload.info`, defined in
`codex.utils.ts`):

```ts
export interface TokenCountPayload {
  type: 'token_count';
  info: {
    total_token_usage?: TokenUsageBlock; // Cumulative since session start (monotonic)
    last_token_usage?: TokenUsageBlock;  // The most recent single call's usage
    model_context_window: number | null;
  };
  rate_limits: unknown;
}

export interface TokenUsageBlock {
  input_tokens?: number;          // OpenAI: INCLUDES cached_input_tokens
  cached_input_tokens?: number;
  output_tokens?: number;         // INCLUDES reasoning
  reasoning_output_tokens?: number;
  total_tokens?: number;
}
```

- `total_token_usage` is the **running session total** — it only ever grows.
- `last_token_usage` is a snapshot of the latest call.

### 2.2 The bug, on real data (VERIFICATION_FINDINGS §3.1)

A real 2-turn rollout:

```
TASK_STARTED turn=A
   TOKEN_COUNT last_in=18800  total_in=18800     (turn A's only call)
TURN_ABORTED
TASK_STARTED turn=B
   TOKEN_COUNT last_in=18800  total_in=18800      ← RE-EMISSION of turn A's last call
   TOKEN_COUNT last_in=22398  total_in=41198      (turn B call 1)
   TOKEN_COUNT last_in=30860  total_in=72058      (turn B call 2)
   TOKEN_COUNT last_in=35629  total_in=107687     (turn B call 3)
TASK_COMPLETE turn=B
```

- **Current (wrong):** sum `last_in` over turn B = `18800 + 22398 + 30860 + 35629 = 107,687`.
- **Correct:** `total_in(end) − total_in(start) = 107687 − 18800 = 88,887`.
- The `18,800` over-count is exactly turn A's last call, re-emitted at turn B's start.

### 2.3 The fix in one sentence

A turn's usage = **the last `token_count` event's `total_token_usage`** (the turn's end
cumulative) **minus the prior turn's final `total_token_usage`** (the start anchor, persisted
across ticks). Re-emissions repeat the anchor/total, so they cancel out.

### 2.4 Per-field formulas (all clamp at ≥ 0)

Let `end = readTurnEndCumulative(turnLines)` and `start = priorCumulative` (the anchor; treat
`null` and missing fields as `0`):

| Stored column | Formula |
|---|---|
| `cache_read_input_tokens` | `cachedDiff = max(0, end.cached − start.cached)` |
| `input_tokens` (non-cached) | `max(0, (end.input − start.input) − cachedDiff)` |
| `output_tokens` | `max(0, end.output − start.output)` |
| `reasoning_output_tokens` | `max(0, end.reasoning − start.reasoning)` |
| `cache_creation_input_tokens` | `null` (unchanged — Codex has no cache-write counter) |

`input_tokens` ends up **non-cached** because OpenAI's `input_tokens` includes the cached
half, and the gateway's model wants non-cached input separately from `cache_read`. This
mirrors the existing per-event `max(0, input − cached)` logic — just applied to the diffed
totals instead of per-event.

### 2.5 Worked check against the canonical case (anchor = turn A's end = {input:18800, cached:14720})

Turn B `end = {input:107687, cached:30592}` (from the last frame's totals):
- `cachedDiff = 30592 − 14720 = 15,872` → `cache_read_input_tokens = 15872`
- `input_tokens = max(0, (107687 − 18800) − 15872) = 88887 − 15872 = 73,015` (non-cached)
- The re-emission frame contributed nothing because its total equalled the anchor. ✅

---

## 3. CHANGE 1 — `codex.utils.ts` (the math)

**File:** `src/agent-gateway/parsers/codex/codex.utils.ts`

### 3.1 Add a helper: the turn's end cumulative

Add this exported function next to `aggregateUsage` (it needs `TokenUsageBlock`, already
defined in this file):

```ts
/**
 * The cumulative session total at the END of this turn: the `total_token_usage`
 * of the LAST `token_count` event in the turn that carries one. `total_token_usage`
 * is monotonic and re-emitted frames repeat it, so the last one is the turn's true
 * endpoint. Returns null when no event in the turn carried a `total_token_usage`
 * block (older Codex schema) — callers fall back to the legacy delta sum.
 */
export function readTurnEndCumulative(
  lines: CodexLine[],
): TokenUsageBlock | null {
  let end: TokenUsageBlock | null = null;
  for (const line of lines) {
    if (line.type !== 'event_msg') continue;
    const p = line.payload as {
      type?: string;
      info?: { total_token_usage?: TokenUsageBlock };
    };
    if (p.type !== 'token_count') continue;
    if (p.info?.total_token_usage) end = p.info.total_token_usage;
  }
  return end;
}
```

### 3.2 Rewrite `aggregateUsage` to diff cumulatives (with a legacy fallback)

The current `aggregateUsage(lines)` sums `last_token_usage`. Change its signature to take the
**required** prior-cumulative anchor, and split the body into the new diff path + the legacy
sum kept as a private fallback.

**Step A — extract the existing sum body into a private fallback helper.** Take the CURRENT
body of `aggregateUsage` (the loop that sums `last_token_usage` with `addTo` and
`max(0, input − cached)`) and move it verbatim into a new private function:

```ts
// Legacy per-emit delta sum of `last_token_usage`. Used only when NO token_count
// event in the turn carried a `total_token_usage` block (older Codex schema), where
// the cumulative-diff path can't run. Same shape it always produced.
function aggregateUsageByLastTokenSum(lines: CodexLine[]): {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  reasoning_output_tokens: number | null;
} {
  // ... EXACTLY the current loop body of aggregateUsage (inputSum/outputSum/
  // cachedSum/reasoningSum, sawAny, addTo, nonCachedInput, the !sawAny null return,
  // and the final return with cache_creation_input_tokens: null) ...
}
```

**Step B — rewrite the public `aggregateUsage` to the diff path:**

```ts
/**
 * Per-turn token usage = the cumulative-total DIFFERENCE across the turn:
 *   field = max(0, total_token_usage(turn end) − priorCumulative(turn start))
 *
 * `total_token_usage` is the running session total (monotonic). The turn's end is
 * the last `token_count` event's total; the start anchor is the prior turn's final
 * total (carried across ticks in the parse accumulator, null for the first turn).
 * Codex re-emits `token_count` frames at turn boundaries and on rate-limit-only
 * updates; because those frames repeat the cumulative total, the difference excludes
 * them automatically — fixing the historical over-count from summing `last_token_usage`.
 *
 * `input_tokens` is returned NON-CACHED (OpenAI's `input_tokens` includes the cached
 * half): non-cached = inputDiff − cachedDiff; `cache_read_input_tokens` = cachedDiff.
 *
 * Fallback: if no event carried `total_token_usage`, defer to the legacy
 * `last_token_usage` delta sum so older schemas keep parsing.
 */
export function aggregateUsage(
  lines: CodexLine[],
  priorCumulative: TokenUsageBlock | null,
): {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  reasoning_output_tokens: number | null;
} {
  const end = readTurnEndCumulative(lines);
  if (end === null) {
    return aggregateUsageByLastTokenSum(lines);
  }

  const start = priorCumulative ?? {};
  const diff = (e: number | undefined, s: number | undefined): number =>
    Math.max(0, (e ?? 0) - (s ?? 0));

  const inputDiff = diff(end.input_tokens, start.input_tokens);
  const cachedDiff = diff(end.cached_input_tokens, start.cached_input_tokens);
  const outputDiff = diff(end.output_tokens, start.output_tokens);
  const reasoningDiff = diff(
    end.reasoning_output_tokens,
    start.reasoning_output_tokens,
  );

  return {
    input_tokens: Math.max(0, inputDiff - cachedDiff), // non-cached
    output_tokens: outputDiff,
    cache_read_input_tokens: cachedDiff,
    cache_creation_input_tokens: null, // Codex has no cache-write counter
    reasoning_output_tokens: reasoningDiff,
  };
}
```

> **DECISION (flagged for reviewer): empty-diff turns report `0`, not `null`.** The diff path
> returns numbers (0 when the turn's cumulative did not grow past the anchor), never null. This
> is a deliberate, downstream-visible behavior choice: a turn that genuinely consumed nothing is
> an authoritative `0`, not an "unknown" `null`. `0` and `null` ARE distinguishable downstream
> (cost/KPI display, `build-scalar-spine` reads), so this is a real wire-shape decision, not an
> accident — the legacy sum could yield `null`/"unknown" for a zero-growth turn; the diff path
> yields `0`/authoritative, which is more truthful. The all-null result survives only for the
> fallback's "no usage events at all" case, preserved inside `aggregateUsageByLastTokenSum`.
> §7.1 Test E pins this `0`-not-`null` contract. Do not coerce empty diffs back to null.

---

## 4. CHANGE 2 — `codex-finalize-turn.service.ts` (thread the anchor in)

**File:** `src/agent-gateway/parsers/codex/services/codex-finalize-turn.service.ts`

### 4.1 Add the anchor to `FinalizeTurnParams`

Add an **optional** field to the `FinalizeTurnParams` interface:

```ts
  /**
   * The prior turn's final cumulative `total_token_usage`, carried across ticks
   * by the parse accumulator. Null for the first turn of a session, and absent
   * when a caller supplies no anchor. Used by aggregateUsage to compute this
   * turn's tokens as a cumulative difference.
   */
  priorCumulativeUsage?: TokenUsageBlock | null;
```

Import `TokenUsageBlock` in this file's existing import from `'../codex.utils'` (add it to
the `type` import list alongside `CodexLine`, `aggregateUsage`, etc.).

> **DECISION (flagged for reviewer): the field is OPTIONAL (`?`), not required.** The spec
> `src/agent-gateway/parsers/codex/tests/codex-finalize-turn.service.spec.ts` constructs a
> `FinalizeTurnParams` object literal at **13** `finalizeTurn({...})` call sites — lines 255,
> 481, 1116, 1232, 1876, 1898, 1997, 2035, 2153, 2169, 2185, 2201, 2230. Declaring
> `priorCumulativeUsage` as **required** would break every one of them with TS2741
> ("property `priorCumulativeUsage` is missing") under `bun run typecheck`, and the plan would
> then have to enumerate 13 spec edits. Declaring it **optional** and defaulting it to `null`
> inside `buildScratch` (§4.2) via `?? null` is identical at runtime, leaves all 13 existing
> call sites compiling untouched, and only the deliberate multi-turn assertions in §7.3 ever
> pass a non-null anchor. **Keep the `?`. Do not make it required.**

### 4.2 Pass it through `buildScratch` to `aggregateUsage`

Update `buildScratch`'s signature and the one `aggregateUsage` call inside it:

```ts
function buildScratch(
  lines: CodexLine[],
  chat: ChatBundle,
  sessionMeta: SessionMetaPayload,
  turnContext: TurnContextPayload | null,
  turnId: string,
  parentTurnId: string | null,
  priorCumulativeUsage: TokenUsageBlock | null,
): Record<string, unknown> {
  const usage = aggregateUsage(lines, priorCumulativeUsage);
  // ... the remaining body stays exactly as it is today ...
}
```

(`buildScratch` is a local function, so its `priorCumulativeUsage` parameter can stay
non-optional — the optional `?` lives only on the public `FinalizeTurnParams` interface.)

Then find the `buildScratch(...)` call inside `finalizeTurn` and pass
`params.priorCumulativeUsage ?? null` as the new last argument. The `?? null` supplies the
default for the optional interface field, so the 13 spec call sites (and any other caller) that
omit `priorCumulativeUsage` still type-check and behave as a first-turn (null) anchor.

### 4.3 `result.usage` mapping — leave the reads as-is, refresh the comment

The `result.usage` block (around the `getValue('result.usage.input_tokens')` reads) does
**not** change — the extractors read the diffed `scratch.usage`. But update the now-current
comment block on `thread_cumulative_tokens` / `tokens_are_estimated` to describe present
behavior (no "deferred"/"will flip" language):

```ts
        // Codex tokens are derived by differencing the cumulative `total_token_usage`
        // across the turn (exact arithmetic on the reported running totals), so they are
        // authoritative, not estimated.
        tokens_are_estimated: false,
        // ...
        // The session cumulative total is tracked in the parse accumulator to difference
        // each turn; it is not surfaced as its own column today.
        thread_cumulative_tokens: null,
```

> **DECISION (flagged for the reviewer):** `tokens_are_estimated` stays **`false`**. The
> cumulative difference is exact arithmetic over Codex's own reported totals — it is more
> accurate than the prior sum, not an estimate. (If the reviewer wants the "synthesized"
> semantic instead, this single boolean is where to flip it. Do not change it without that
> instruction.)

---

## 5. CHANGE 3 — `codex-parse-chat.service.ts` (persist + update the anchor)

**File:** `src/agent-gateway/parsers/codex/services/codex-parse-chat.service.ts`

This is where the anchor lives across ticks. The accumulator (`CodexAccumulator`) is persisted
JSONB. `TokenUsageBlock` is a plain `{ number }` object, so it serializes cleanly.

### 5.1 Add the field to the accumulator (NO version bump)

Add to the `CodexAccumulator` interface:

```ts
  /**
   * The prior turn's final cumulative `total_token_usage`. The start anchor for the
   * next turn's cumulative-difference token computation. Null at session start.
   */
  priorCumulativeUsage: TokenUsageBlock | null;
```

Add `priorCumulativeUsage: null` to `emptyAccumulator()`.

In `loadAccumulator`, inside the `blob.v === ACCUMULATOR_VERSION` branch, add:

```ts
        priorCumulativeUsage: blob.priorCumulativeUsage ?? null,
```

Import `type TokenUsageBlock` and `readTurnEndCumulative` from `'../codex.utils'` (add to the
existing import block).

> **DECISION (why no `ACCUMULATOR_VERSION` bump):** this field is **additive and optional** —
> old `v2` blobs simply load it as `null`. Bumping the version would reset every active
> session's accumulator on deploy, discarding in-flight open-turn lineage. Additive keeps open
> turns intact. The only cost is that a turn whose anchor is `null` because it straddles the
> deploy (or is genuinely first) diffs against `0`; see §5.3.

### 5.2 Read the anchor on the way in, update it on the way out (`flushOpenTurn`)

In `flushOpenTurn`, two edits:

**(a)** When calling `finalizeTurn(...)`, pass the current anchor:

```ts
    const finalized = finalizeTurn({
      lines: openLines,
      // ... the fields already passed here stay as they are ...
      turnContext,
      priorCumulativeUsage: acc.priorCumulativeUsage,
    });
```

**(b)** Immediately AFTER the `finalizeTurn(...)` call (before the `acc.openTurnId = null`
lineage-clear at the bottom), advance the anchor from THIS turn's end cumulative — regardless
of whether `finalized` was null:

```ts
    // Advance the session anchor to this turn's final cumulative so the NEXT turn
    // differences against it. Do this even when `finalized === null` (a dropped/empty
    // turn still consumed tokens that the cumulative reflects) so the next turn isn't
    // over-counted. Stays put when this turn carried no total_token_usage (fallback regime).
    const turnEndCumulative = readTurnEndCumulative(openLines);
    if (turnEndCumulative !== null) {
      acc.priorCumulativeUsage = turnEndCumulative;
    }
```

Place this in the NORMAL flush path (after `finalizeTurn`), NOT in the early-return defensive
branch at the top of `flushOpenTurn` (the `acc.sessionMeta === null || …` guard) — that branch
resets partial state and returns before finalizing. Do **not** hoist the anchor-advance above
that guard: the partial-state branch intentionally leaves `acc.priorCumulativeUsage` unchanged,
because a turn flushed on uncertain/partial state has no trustworthy end cumulative to anchor
the next turn against. The anchor advances only once a turn has reached the real finalize path.

### 5.3 Edge cases you are explicitly handling (verifier will check)

- **First turn of a session:** anchor is `null` → treated as `0` → usage = end − 0 = the
  turn's true total. Correct.
- **Rate-limit-only re-emit mid-turn:** repeats the same total → doesn't move the endpoint →
  excluded. Correct.
- **Turn-boundary re-emission (first frame of a new turn):** its total equals the anchor →
  contributes 0 to the diff. Correct.
- **Dropped/empty turn that still consumed tokens:** anchor advances anyway (§5.2(b)), so the
  next turn isn't over-counted.
- **No `total_token_usage` at all (older schema):** `readTurnEndCumulative` → null →
  `aggregateUsage` falls back to the legacy `last_token_usage` sum; anchor unchanged.
- **Deploy-straddling in-flight turn (anchor null mid-session):** that one turn diffs against
  0 and transiently over-counts; this is bounded, one-time, and corrected by Phase 11's
  cold-start re-parse (which starts the anchor null at the session's true first turn). Note it
  in your report; do not add special-casing for it.
- **Truncated turn flushed because a different `turn_id` opened (the truncated-turn flush path,
  a different `turn_id` arriving while one is open):** this still runs through the normal
  `flushOpenTurn → finalizeTurn` path, so §5.2(b) advances the anchor from the truncated turn's
  end cumulative and the subsequent turn is differenced correctly (not over-counted). No
  separate code is needed — the §5.2(b) anchor-advance already covers it because it runs on
  every normal flush regardless of `finalized` being null.

---

## 6. CHANGE 4 — `extractors/usage.ts` (docstring + fallback call)

**File:** `src/agent-gateway/parsers/codex/extractors/usage.ts`

### 6.1 Fix the stale top-of-file docstring

The current docstring claims "We use `last_token_usage` from the LATEST `token_count` event"
— which was never the real behavior and is not the new behavior. Replace it with:

```ts
/**
 * Codex — `result.usage.*` extractors.
 *
 * Token usage is computed by `aggregateUsage` as the cumulative-total DIFFERENCE
 * across the turn: `total_token_usage(turn end) − priorCumulative(turn start)`.
 * The diffed roll-up is precomputed once per turn into `ctx.scratch.usage` by
 * `buildScratch`; these extractors just read individual fields off it.
 *
 * `input_tokens` is non-cached (OpenAI input includes cached); `cache_creation`
 * is always null (Codex emits no cache-write counter).
 */
```

### 6.2 Fix the `getUsage` fallback call (it must pass the new required arg)

`aggregateUsage` now takes two args. In `getUsage`, the fallback path calls it with the
turn lines but has no anchor in scope — pass `null` (in production `ctx.scratch.usage` is
always precomputed with the real anchor, so this fallback only fires in isolated unit tests):

```ts
function getUsage(ctx: ExtractContext): ReturnType<typeof aggregateUsage> {
  const cached = ctx.scratch?.usage as
    | ReturnType<typeof aggregateUsage>
    | undefined;
  if (cached) return cached;
  const lines = (ctx.scratch?.lines as CodexLine[] | undefined) ?? [];
  return aggregateUsage(lines, null);
}
```

---

## 7. CHANGE 5 — Tests

Runner: `bun run test:unit <path>` (Vitest). Codex specs live in
`src/agent-gateway/parsers/codex/tests/`.

### 7.1 Rewrite the one test that asserted the old sum semantics

In `tests/codex.utils.spec.ts`, the `describe('aggregateUsage')` block has
`it('SUMS last_token_usage across all token_count events (per-emit deltas)', …)`. That
behavior is gone. **Replace that `it(...)` with the cumulative-diff tests below.** Also: every
remaining `aggregateUsage(...)` call in the codex specs now needs the second argument — when a
test means "no prior turn", pass `null`.

The `TOKEN_COUNT` fixture already in that file is:
`total_token_usage {input:100, cached:20, output:50, reasoning:5}` and
`last_token_usage {input:80, cached:15, output:40, reasoning:3}`.

**Test A — single turn, no prior anchor (= end − 0):**
```ts
it('computes a turn from total_token_usage(end) minus a null anchor (treated as zero)', () => {
  const u = aggregateUsage([parseCodexLine(TOKEN_COUNT)!], null);
  expect(u.input_tokens).toBe(80);            // (100 - 0) - (20 - 0) non-cached
  expect(u.cache_read_input_tokens).toBe(20); // 20 - 0
  expect(u.output_tokens).toBe(50);           // 50 - 0
  expect(u.reasoning_output_tokens).toBe(5);  // 5 - 0
  expect(u.cache_creation_input_tokens).toBeNull();
});
```

**Test B — the canonical re-emission over-count case (the heart of F2):** build a 2-turn
fixture where turn 2 opens with a re-emission of turn 1's final cumulative, then assert the
diff, NOT the sum. Use small explicit numbers:

```ts
it('excludes a re-emitted start-of-turn frame via the cumulative difference', () => {
  // Turn 1 ended at cumulative {input:18800, cached:14720}. Turn 2's frames
  // (total_in): re-emit 18800, then 41198, 72058, 107687 (cached climbs to 30592).
  const tc = (totalIn: number, cached: number) =>
    parseCodexLine(
      JSON.stringify({
        timestamp: 't',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: totalIn, cached_input_tokens: cached },
            last_token_usage: { input_tokens: 1, cached_input_tokens: 0 },
          },
          rate_limits: null,
        },
      }),
    )!;
  const turn2 = [tc(18800, 14720), tc(41198, 14720), tc(72058, 21888), tc(107687, 30592)];
  const prior = { input_tokens: 18800, cached_input_tokens: 14720 };
  const u = aggregateUsage(turn2, prior);
  // end {input:107687, cached:30592} minus prior {18800, 14720}
  expect(u.cache_read_input_tokens).toBe(15872);        // 30592 - 14720
  expect(u.input_tokens).toBe(88887 - 15872);           // (107687-18800) - 15872 = 73015
  // The naive sum (107687) would have over-counted by exactly the 18800 re-emission.
});
```

**Test C — rate-limit-only re-emit within a turn (unchanged total) is not double-counted:**
```ts
it('does not double-count a rate-limit re-emit that leaves total_token_usage unchanged', () => {
  const frame = (totalIn: number) =>
    parseCodexLine(
      JSON.stringify({
        timestamp: 't',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { total_token_usage: { input_tokens: totalIn, cached_input_tokens: 0 } },
          rate_limits: null,
        },
      }),
    )!;
  // 100, then a rate-limit re-emit of 100 (unchanged), then 250.
  const u = aggregateUsage([frame(100), frame(100), frame(250)], null);
  expect(u.input_tokens).toBe(250); // end 250 - 0; the repeated 100 frame is inert
});
```

**Test D — missing `total_token_usage` falls back to the legacy last-token sum:**
```ts
it('falls back to summing last_token_usage when no total_token_usage is present', () => {
  const lastOnly = (inp: number, out: number) =>
    parseCodexLine(
      JSON.stringify({
        timestamp: 't',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { last_token_usage: { input_tokens: inp, output_tokens: out, cached_input_tokens: 0 } },
          rate_limits: null,
        },
      }),
    )!;
  const u = aggregateUsage([lastOnly(10, 5), lastOnly(20, 8)], null);
  expect(u.input_tokens).toBe(30); // legacy delta sum: (10-0)+(20-0)
  expect(u.output_tokens).toBe(13);
});
```

**Test E — a zero-growth turn reports authoritative `0`, not `null` (pins the §3.2 decision):**
```ts
it('reports 0 (not null) for a turn whose cumulative total did not grow past the anchor', () => {
  const frame = parseCodexLine(
    JSON.stringify({
      timestamp: 't',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 500,
            cached_input_tokens: 100,
            output_tokens: 200,
          },
        },
        rate_limits: null,
      },
    }),
  )!;
  // end == prior anchor → every field diffs to 0; this is authoritative 0, not unknown.
  const prior = { input_tokens: 500, cached_input_tokens: 100, output_tokens: 200 };
  const u = aggregateUsage([frame], prior);
  expect(u.input_tokens).toBe(0);
  expect(u.cache_read_input_tokens).toBe(0);
  expect(u.output_tokens).toBe(0);
  expect(u.reasoning_output_tokens).toBe(0);
  expect(u.cache_creation_input_tokens).toBeNull();
});
```

**Test F — the diff path is taken for total-bearing events and the legacy sum for last-only events (path-selection regression guard):**
```ts
it('uses the cumulative-diff path when total_token_usage is present and the legacy sum when it is absent', () => {
  // total-bearing event → diff path: end {input:100, cached:20} - null anchor = 80 non-cached.
  const withTotal = aggregateUsage([parseCodexLine(TOKEN_COUNT)!], null);
  expect(withTotal.input_tokens).toBe(80);
  // last-only event → legacy sum path: the 10 input passes straight through.
  const lastOnly = parseCodexLine(
    JSON.stringify({
      timestamp: 't',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 0 },
        },
        rate_limits: null,
      },
    }),
  )!;
  expect(aggregateUsage([lastOnly], null).input_tokens).toBe(10);
});
```

### 7.1.1 Existing tests that change value or semantics — ENUMERATED (do not delegate these to a blind run)

These three existing assertions in `tests/codex.utils.spec.ts` change under the diff path.
Apply them explicitly; the empirical run in §7.2 is the safety net, not the primary method.
(Stating old→new here is fine — this is the plan, not shipped code. The shipped test **names**
must describe current behavior only.)

1. **`it('skips token_count events without a last_token_usage block', …)` (≈:620-637).** Its
   fixture is `total_token_usage: { input_tokens: 999, output_tokens: 999 }` with **no**
   `last_token_usage`, and it currently calls `aggregateUsage([noLast])` asserting both fields
   `.toBeNull()`. Under the diff path `readTurnEndCumulative` now finds that total, so against a
   null anchor: `input_tokens = max(0, 999 - 0) = 999`, `output_tokens = 999`,
   `cache_read_input_tokens = 0`, `reasoning_output_tokens = 0`,
   `cache_creation_input_tokens = null`. **Edit:** add the `null` second arg
   (`aggregateUsage([noLast], null)`), change the two assertions to `.toBe(999)`, and **rename**
   the test to describe current behavior — e.g.
   `it('derives a turn from total_token_usage even when last_token_usage is absent', …)`. The
   old "skips" name would now be false; do not keep it.

2. **`it('aggregateUsage skips lines that are not event_msg without throwing', …)` (≈:1242-1247).**
   It calls `aggregateUsage([responseItemLine, tokenLine])` over the shared `TOKEN_COUNT`
   fixture (total `{input:100, cached:20}`) and asserts `input_tokens` is **`65`** (the old
   last-sum: 80−15). Under the diff path with a null anchor: `input_tokens = max(0, 100 − 20) =`
   **`80`**. **Edit:** add the `null` second arg and change `.toBe(65)` → `.toBe(80)`. The test
   name still describes current behavior (skipping non-`event_msg` lines) — keep it.

3. **`tests/codex-extractors.spec.ts` scratch.lines fallback test (≈:676-695).** Its fixture
   carries `last_token_usage` **only** (no `total_token_usage`), so
   `getUsage → aggregateUsage(lines, null) → readTurnEndCumulative null → legacy fallback`. Its
   values stay **8/22/3 unchanged** — this test does **NOT** diff. **Edit:** none required
   beyond any second-arg compile fix if it calls `aggregateUsage` directly; leave the expected
   values exactly as they are. (This corrects the earlier "now diffs" framing in §7.2.)

### 7.2 Fix the rest by running the suite

After applying the three enumerated edits in §7.1.1, run the suite as a **safety net** to catch
any remaining `aggregateUsage(...)` call that still needs (a) the new `null` second arg
(compile fix) or (b) an updated expected value:

```bash
bun run test:unit src/agent-gateway/parsers/codex
```

For each remaining failure decide: is it a **compile** failure (missing 2nd arg → add `, null`
or the right anchor) or a **value** failure (the diff semantics changed the expected number →
update the expectation to the diffed value, and rename the test only if its name described
summing). Do **not** weaken a test to make it pass — make it assert the correct diffed value.
Re-run until green. Specific notes per file:
- `tests/codex.utils.spec.ts` — the three changes are already enumerated in §7.1.1; any other
  `aggregateUsage(...)` call there needs only the `, null` compile fix (its fixture is
  last-only and stays on the legacy path with unchanged values).
- `tests/codex-extractors.spec.ts` — the scratch.lines fallback test (≈:676-695) carries
  `last_token_usage` only, so it stays on the **legacy** path and its values are **unchanged**
  (see §7.1.1 item 3). It does NOT diff. Only a second-arg compile fix applies if it calls
  `aggregateUsage` directly.
- `tests/codex-parse-chat.service.spec.ts` and `tests/codex-finalize-turn.service.spec.ts` —
  the existing `turnLines`-based fixtures emit `last_token_usage` only (no `total_token_usage`),
  so they route through the legacy fallback and their stored token totals are **unchanged**
  (e.g. the single-turn `input_tokens` stays `8`). The 13 `finalizeTurn({...})` call sites
  compile without edits because the field is optional (§4.1). The only multi-turn diff fixture
  is the new one you add in §7.3.

### 7.3 A parse-chat-level multi-turn test (REQUIRED — acceptance criterion §11)

This proves the cross-turn anchor threads through `flushOpenTurn → finalizeTurn →
aggregateUsage` (the §7.1 single-function tests prove the math; this proves the threading). The
existing `turnLines` helper emits `last_token_usage`-only events, which route through the legacy
fallback and **cannot** exercise the diff path — so a test built on `turnLines` would pass while
proving nothing. You must add a `total_token_usage`-bearing helper.

Within a **single** `parseChat` call, the in-memory `acc.priorCumulativeUsage` already carries
from turn 1 to turn 2 (it is advanced in `flushOpenTurn`, §5.2(b)), so a single-tick two-turn
fixture is sufficient — no cross-batch resume is needed to prove the anchor.

Add this helper next to `turnLines` in `tests/codex-parse-chat.service.spec.ts`:

```ts
function turnLinesWithTotal(
  turnId: string,
  opts: {
    userText?: string;
    finalText?: string;
    totalInput: number;
    totalCached: number;
    totalOutput?: number;
  },
): string {
  const lines = [
    event({ type: 'task_started', turn_id: turnId, started_at: 0 }),
    event({ type: 'user_message', message: opts.userText ?? 'hello' }),
    ri({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: opts.finalText ?? 'reply' }],
    }),
    event({
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: opts.totalInput,
          cached_input_tokens: opts.totalCached,
          output_tokens: opts.totalOutput ?? 0,
        },
        last_token_usage: {
          input_tokens: 1,
          output_tokens: 1,
          cached_input_tokens: 0,
        },
      },
      rate_limits: null,
    }),
    event({
      type: 'task_complete',
      turn_id: turnId,
      last_agent_message: opts.finalText ?? 'reply',
      completed_at: 0,
    }),
  ];
  return lines.join('\n') + '\n';
}
```

Then add the test (use the canonical anchor numbers from §2.2):

```ts
it('threads the cross-turn cumulative anchor so turn 2 is the total-diff against the turn-1 anchor', async () => {
  const service = makeService();
  const bytes =
    meta('sess-1') +
    '\n' +
    turnLinesWithTotal('turn-1', {
      userText: 'a',
      finalText: 'A',
      totalInput: 18800,
      totalCached: 14720,
    }) +
    turnLinesWithTotal('turn-2', {
      userText: 'b',
      finalText: 'B',
      totalInput: 107687,
      totalCached: 30592,
    });
  const chat = makeChat([makeChunk(bytes, 'cap-1', 200n)]);
  const result = await service.parseChat(null, chat, PARSER_VERSION);
  expect(result.records).toHaveLength(2);
  // Turn 1: null anchor → (18800 − 0) − (14720 − 0) = 4080 non-cached; cache_read 14720.
  expect(result.records[0].result.usage?.input_tokens).toBe(4080);
  expect(result.records[0].result.usage?.cache_read_input_tokens).toBe(14720);
  // Turn 2: anchor {18800, 14720} threaded from turn 1 →
  //   (107687 − 18800) − (30592 − 14720) = 88887 − 15872 = 73015; cache_read 15872.
  // The 18800 re-emission at turn 2's start repeats the anchor total, so the diff excludes it.
  expect(result.records[1].result.usage?.input_tokens).toBe(73015);
  expect(result.records[1].result.usage?.cache_read_input_tokens).toBe(15872);
});
```

`makeService` and `makeChat` are the existing top-level helpers in this spec; constructing
`service` locally keeps the test self-contained regardless of the surrounding `describe` block.

---

## 8. Execution order & commands

1. Edit `codex.utils.ts` (§3) — add `readTurnEndCumulative`, extract the legacy sum, rewrite
   `aggregateUsage`.
2. Edit `codex-finalize-turn.service.ts` (§4) — param + buildScratch + comment.
3. Edit `codex-parse-chat.service.ts` (§5) — accumulator field + flushOpenTurn read/update.
4. Edit `extractors/usage.ts` (§6) — docstring + fallback call.
5. Tests (§7) — rewrite + add, then run the suite to green.
6. Run:
   ```bash
   bun run typecheck
   bun run test:unit src/agent-gateway/parsers/codex
   ```
   Do NOT run `bun run validate` while iterating.

If a command fails, fix the cause — never silence it with a suppression or an `any`.

---

## 9. Audit / self-check before hand-back

- `grep -n "total_token_usage" src/agent-gateway/parsers/codex/codex.utils.ts` → the
  cumulative-diff logic is present (`readTurnEndCumulative` + the diff in `aggregateUsage`).
- `grep -rn "aggregateUsage(" src/agent-gateway/parsers/codex` → **every** call site passes a
  2nd argument (no 1-arg calls remain).
- `grep -n "use latest\|last-wins\|LATEST" src/agent-gateway/parsers/codex/extractors/usage.ts`
  → returns nothing (stale docstring corrected).
- Confirm the accumulator field was added **without** changing `ACCUMULATOR_VERSION`.
- Confirm `cache_creation_input_tokens` is still `null` for Codex and you did **not** touch the
  Claude/Gemini/Cursor parsers or `build-scalar-spine.ts`.

---

## 10. Hand-back report (send this back to the orchestrator/verifier)

1. **Files changed** (path + one line each).
2. **The diffs** for the 4 source files, pasted verbatim.
3. **Test results**: paste the green output of `bun run test:unit src/agent-gateway/parsers/codex`
   and `bun run typecheck`.
4. **List the existing tests you updated** and, for each, whether it was a compile fix
   (`, null`) or a value fix (state old→new is fine in the REPORT — just never in shipped
   code/comments).
5. **Confirm the two flagged decisions** were implemented as written: `tokens_are_estimated`
   stays `false`; accumulator field added with **no** `ACCUMULATOR_VERSION` bump.
6. **Note** the deploy-straddle transient (§5.3) as a known, backfill-corrected edge.
7. **Anything you could not do without an `any`/suppression** — name the type friction instead
   of working around it.

---

## 11. Acceptance criteria (the verifier checks all)

- [ ] Multi-turn sessions no longer add the prior turn's final call into the next turn (turn N
      tokens = `total(end) − total(start anchor)`).
- [ ] Rate-limit-only re-emits (unchanged `total_token_usage`) are excluded.
- [ ] Cross-tick partial-turn captures handled: the anchor is persisted in the accumulator and
      threaded through `flushOpenTurn → finalizeTurn → aggregateUsage`; no new under-count.
- [ ] Missing-`total_token_usage` fallback path works (legacy `last_token_usage` sum).
- [ ] Stale `extractors/usage.ts` docstring corrected (no "use latest" while the code diffs).
- [ ] The 6 new unit tests (A–F, §7.1) + the required parse-chat multi-turn test (§7.3) are
      green; the full codex spec suite is green; `typecheck` passes.
- [ ] The three enumerated existing tests (§7.1.1) are updated: the "skips token_count" test
      now asserts 999/999 and is renamed to current behavior; the non-`event_msg` skip test
      asserts `80`; the extractors fallback test keeps its `8/22/3` values (legacy path).
- [ ] A zero-growth turn reports authoritative `0` (not `null`) — Test E green (§3.2 decision).
- [ ] `FinalizeTurnParams.priorCumulativeUsage` is **optional** (`?`); the 13 existing
      `finalizeTurn({...})` spec call sites compile with no edits (§4.1).

---

## 12. Out of scope (do NOT do these)

- **Do not** populate `thread_cumulative_tokens` or add a reasoning-token column — both are
  explicitly deferred (ROADMAP "Decisions LOCKED"). Keep `thread_cumulative_tokens: null`.
- **Do not** touch the Claude Code, Gemini, or Cursor parsers, or the shared
  `build-scalar-spine.ts`. Phase 2 is Codex-only.
- **Do not** change the gateway repo. F2 is `proxai_nest` only.
- **Do not** bump `ACCUMULATOR_VERSION` (see §5.1).
- **Do not** change `cache_creation_input_tokens` (stays null for Codex).
- Historical correction is Phase 11's job (re-parse from S3) — you only fix forward logic.

### Cross-phase coordination (shared file)

- **Phase 6 (Codex re-attach guard) also edits `codex-parse-chat.service.ts`.** Phase 6 touches
  the `task_started` dedup / re-attach region (≈lines 229-242); Phase 2 touches the
  `CodexAccumulator` interface / `emptyAccumulator` / `loadAccumulator` and the `flushOpenTurn`
  anchor-advance. These are **different regions of the same file** with no logic overlap, but if
  both phases are in flight, expect a merge touch-point in this file and coordinate merge order
  with the operator (either order is safe; resolve by keeping both region edits).
- Phase 9 (`deterministicRecordId` in `parsers.utils.ts` + `metric-kind-registry.ts`) and
  Phase 11 (prod backfill) do not share any file with Phase 2.
