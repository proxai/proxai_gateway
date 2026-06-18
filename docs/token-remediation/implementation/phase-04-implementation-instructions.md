# Phase 4 — Implementation Instructions (for the implementer model)

> **Audience:** the small/fast implementer model that will write the code.
> **Author:** orchestrator chat (source-verified against `proxai_nest` on 2026-06-17).
> **Companion specs (already settled — do not re-open):**
> `../phase-04-upsert-shrink-guard.md`, `../ROADMAP.md`,
> `../analysis/VERIFICATION_FINDINGS.md` §10.3/§11.2/§11.3,
> `../analysis/IMPLEMENTATION_PLAN.md` Rank 4.
>
> Everything you need is here. Every path/line/snippet below was read from the
> actual source. **Follow it literally.** If line numbers have drifted, trust the
> *named symbol* (function / SQL clause / interface name), not the line number.
>
> **This phase is `proxai_nest` ONLY.** No gateway change. **No schema/migration
> change.** No new module, no queue change. You touch ONE product source file, ONE
> registry file, and TWO test files (+ one test fixture).

---

## 0. TL;DR — what you are doing

The shared batch upsert at
`src/agent-gateway/parse/services/parse-batch-upsert.service.ts` writes every
parsed turn into `agent_call_records` with `INSERT … ON CONFLICT (id) DO UPDATE
SET <~30 cols> = EXCLUDED.*`. The `DO UPDATE` is gated by a **watermark-only**
`WHERE`: it accepts any re-emit whose `last_capture_watermark_end` is strictly
greater than the stored row's. That gate is blind to token/content *quality* — so
a higher-watermark re-emit carrying a **smaller** post-flush window can overwrite
all ~30 columns (the 4 token columns **and** `final_text` / `result_content` /
`stop_reason` / `user_input_content`) of a fuller, already-finalized turn.

You will add a **shrink guard** to that same `WHERE`: refuse the UPDATE when it
would **strictly shrink** the turn's tokens (`EXCLUDED.input_tokens +
output_tokens < existing input_tokens + output_tokens`, NULLs treated as 0). One
clause, one statement — it protects every column the `WHERE` already gates, not
just tokens. You will also widen the pre-existing prior-status `SELECT` to fetch
the existing token totals and emit a **registered counter** for each rejected
shrink so the population is observable in prod.

This is **defense-in-depth**. Per the ROADMAP pre-flight, idle-flush advances the
*same* `agent_parse_states.last_processed_watermark` the main parser reads, so the
Claude Code *same-promptId* overwrite is unlikely to fire; the **live trigger is
the Codex `task_started` re-attach** (Phase 6's scenario — new post-flush captures
re-open a turn and re-finalize the same deterministic id with a smaller window).
The guard neutralizes that, the Claude Code idle case, and broad content-column
corruption at once.

**Files you will touch (all `proxai_nest`):**

1. `src/agent-gateway/parse/services/parse-batch-upsert.service.ts` — the SQL
   `WHERE` (the guard), the widened pre-SELECT, the rejection metric, and the
   class docstring. *(the only product source change)*
2. `src/telemetry/metric-kind-registry.ts` — register the new counter.
3. `src/agent-gateway/parse/tests/parse-batch-upsert.service.spec.ts` — fix one
   test helper (required, or existing tests break) + add unit tests.
4. `src/agents/orchestration/tests/parse-batch-upsert-returning-xmax.int-spec.ts`
   + its fixture `…/tests/fixtures/acr-seed.fixture.ts` — add real-PG cases.

---

## 1. Hard rules (non-negotiable — enforced by lint / CI / reviewers)

- **No `any`** — not `: any`, `as any`, `Promise<any>`, `Record<string, any>`,
  generic `= any`, or implicit any, in source **or** `.spec.ts` / `.int-spec.ts`.
  Use `unknown` + a narrowing guard. If a 3rd-party type forces an any, **stop and
  report it**, don't insert one.
- **No suppression comments** — `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`,
  `eslint-disable`, `oxlint-disable`, `v8 ignore`. Fix the type instead.
- **No "before/after" references** in code, comments, or test names. Describe
  **current** behavior only. A test name says what the code does now (e.g.
  `it('refuses a watermark-advancing write that strictly shrinks the turn tokens', …)`),
  never "no longer overwrites" / "used to clobber".
- **Comments explain *why***, not *what*. No decorative banners.
- **No hardcoded enum-string values** — none are needed here; if you reach for a
  status literal, import from `src/types/agent_call_record.ts` (`TurnStatusTypes`).
- **Package manager: `bun`.** Tests: `bun run test:unit <path>` (Vitest, unit) and
  `bun run test:integration:vitest <path>` (real Postgres). Never raw `vitest`.
  Typecheck: `bun run typecheck`. Do **not** run `bun run validate` while iterating.
- **Never mock the DB in the integration spec** — `*.int-spec.ts` runs against the
  real proxai-ops Postgres. Assert observable DB state, not mock calls.
- **Git:** do **not** commit / push / branch / stage unless the operator tells you
  to. Leave edits in the working tree.

---

## 2. Mental model — READ THIS BEFORE WRITING CODE

### 2.1 What the upsert does today (verified against current source)

`parse-batch-upsert.service.ts` builds one multi-row
`INSERT … ON CONFLICT (id) DO UPDATE SET … = EXCLUDED.*` per chat. The
`DO UPDATE` is gated by a watermark-monotonicity `WHERE` (verified at lines
540-545):

```sql
WHERE
  agent_call_records.last_capture_watermark_end IS NULL
  OR (
    EXCLUDED.last_capture_watermark_end IS NOT NULL
    AND EXCLUDED.last_capture_watermark_end > agent_call_records.last_capture_watermark_end
  )
```

The SET list assigns ~30 columns including the 4 token columns (verified at lines
515-518):

```sql
input_tokens = EXCLUDED.input_tokens,
output_tokens = EXCLUDED.output_tokens,
cache_creation_input_tokens = EXCLUDED.cache_creation_input_tokens,
cache_read_input_tokens = EXCLUDED.cache_read_input_tokens,
```

…and the content columns `final_text`, `stop_reason`, `result_content`,
`user_input_content`, `user_input_text`, `user_input_attachments`, `provider`,
`model`, etc. — all `= EXCLUDED.*`, all gated by that one `WHERE`.

The class docstring already names this exact hazard (verified at lines 32-41,
"BLAST-RADIUS NOTE"): *"The gate only checks the watermark, not per-column
quality. If a parser regression emits a wider-watermark row with NULL where prod
had values, the gate fires and the SET overwrites those values with NULL."* This
phase closes that hole for the token-shrink shape.

### 2.2 The corruption, on concrete numbers (the Codex re-attach — live trigger)

A Codex turn finalizes cleanly at `task_complete` and is stored:

```
ACR row  (id = blake2b(agent|chat|turn))
   input_tokens             = 88,887
   output_tokens            = 12,000     (turn total = 100,887)
   final_text               = "<the full assistant answer>"
   stop_reason              = "completed"
   last_capture_watermark_end = 5000      (byte offset in the rollout)
```

Later, **new post-flush captures** arrive carrying a re-emitted `task_started`
that re-opens the same turn. The parser re-finalizes the **same deterministic id**
from a smaller, partial window and emits a fresh row:

```
EXCLUDED row (same id)
   input_tokens             = 18,800
   output_tokens            = 2,000      (turn total = 20,800)
   final_text               = null       (partial re-attach has no closing text yet)
   stop_reason              = null
   last_capture_watermark_end = 6000      (HIGHER — more bytes were captured)
```

- **Without the guard:** `6000 > 5000` ⇒ watermark gate passes ⇒ the UPDATE fires
  ⇒ the row is overwritten with `18,800 / 2,000` **and** `final_text` / `stop_reason`
  / `result_content` are clobbered. The turn's reported usage collapses from
  100,887 to 20,800 and its content disappears. ~30 columns corrupted.
- **With the guard:** watermark gate still passes (`6000 > 5000`), but the shrink
  guard asks *"does the new total `20,800` ≥ the stored total `100,887`?"* — no
  (`20,800 < 100,887`) ⇒ the **entire** UPDATE is refused. The row keeps
  `88,887 / 12,000` and all its content. `agent_gateway_parse_shrink_rejected_total{agent=CODEX}`
  increments by 1.

### 2.3 The fix in one sentence

AND a token non-shrink clause onto the existing watermark `WHERE`:
`(EXCLUDED.input_tokens + output_tokens) >= (existing input_tokens + output_tokens)`
with NULLs coalesced to 0 — so a watermark-advancing write that would strictly
shrink the turn is refused, preserving **all** gated columns; legitimate growth
and equal-token re-emits (same tokens, fuller content / advanced lineage) still
win.

### 2.4 Why `>=` and why COALESCE(…, 0), precisely

| Case | EXCLUDED total | existing total | `>=` outcome | Why correct |
|---|---|---|---|---|
| Smaller post-flush window (the bug) | 20,800 | 100,887 | **refuse** | Don't clobber a fuller turn |
| Legitimate larger re-parse | 120,000 | 100,887 | apply | Real growth must win |
| Equal tokens, fuller content / lineage | 100,887 | 100,887 | apply | Re-parse with same tokens but better content updates |
| INCOMPLETE re-emit with `usage = null` | 0 | 100,887 | **refuse** | A null-usage touch must not null a finalized turn |
| First write over a legacy NULL-token row | any | 0 | apply | `x ≥ 0` always holds |

`>=` (not `>`) is deliberate: an equal-token re-emit must still be allowed to
update the content/lineage columns. Only a **strict** shrink is refused. NULL
EXCLUDED tokens coalesce to 0, so an INCOMPLETE/partial re-emit (which carries
`usage = null`, hence `input_tokens`/`output_tokens` NULL via `buildScalarSpine`,
verified at `build-scalar-spine.ts:160-161`) can never overwrite a positive-token
row — that is the corruption shape, not a false positive.

### 2.5 Why the metric needs the pre-SELECT, not RETURNING

A row the `WHERE` vetoes is **silently absent from RETURNING** (verified comment at
lines 561-564). So RETURNING cannot tell you *why* a row was vetoed (watermark vs
shrink). To attribute a rejection to the shrink guard you need the row's
**pre-state**. The service already runs a prior-status pre-SELECT under the per-chat
advisory lock (verified at lines 348-352); you widen it to also fetch the existing
token totals and watermark, then compute — in app code, from the same prior state +
the same `EXCLUDED` values (`flat`) the SQL uses — the count of rows where *the
watermark gate passes but the shrink guard fails*. That is the precise "guard
actually changed behavior" population the spec wants sized in prod, and it is the
only form a unit test can observe (the SQL outcome can't be introspected from a
mocked `$queryRaw`).

> The app-side count and the SQL `WHERE` read the **same** prior rows (one
> advisory-locked pre-SELECT) and the **same** `EXCLUDED` values (`flat`), so they
> are guaranteed consistent. Keep them in sync: if you change the SQL operator,
> change the mirror — the unit tests in §4 pin both.

---

## 3. Change spec

All §3.x except §3.4 are in
**`src/agent-gateway/parse/services/parse-batch-upsert.service.ts`**.

### 3.1 Add the token-shrink guard to the `ON CONFLICT … WHERE`

Find the current `WHERE` inside `upsertChunk` (verified at lines 540-545):

```ts
      WHERE
        agent_call_records.last_capture_watermark_end IS NULL
        OR (
          EXCLUDED.last_capture_watermark_end IS NOT NULL
          AND EXCLUDED.last_capture_watermark_end > agent_call_records.last_capture_watermark_end
        )
      RETURNING
```

Replace with (wrap the existing watermark group in parens, then `AND` the shrink
guard):

```ts
      WHERE
        (
          agent_call_records.last_capture_watermark_end IS NULL
          OR (
            EXCLUDED.last_capture_watermark_end IS NOT NULL
            AND EXCLUDED.last_capture_watermark_end > agent_call_records.last_capture_watermark_end
          )
        )
        -- Token shrink-guard (defense-in-depth on top of the watermark gate):
        -- refuse a watermark-advancing UPDATE that would STRICTLY shrink the
        -- turn's (input + output) tokens. NULLs are 0, so an INCOMPLETE / partial
        -- re-attach carrying null usage can't null out a finalized turn, and the
        -- ~30 gated content columns are protected alongside the 4 token columns.
        -- `>=` (not `>`) keeps equal-token re-parses — same tokens, fuller content
        -- or advanced lineage — winning. ::bigint avoids int4 overflow on the sum.
        AND (
          COALESCE(EXCLUDED.input_tokens, 0)::bigint
            + COALESCE(EXCLUDED.output_tokens, 0)::bigint
          >= COALESCE(agent_call_records.input_tokens, 0)::bigint
            + COALESCE(agent_call_records.output_tokens, 0)::bigint
        )
      RETURNING
```

> **Why `::bigint`:** `input_tokens` / `output_tokens` are Postgres `Int?` (int4,
> verified `node_modules/@proxai/prisma-schema/schema.prisma:1087-1088` —
> `inputTokens Int? @map("input_tokens")` / `outputTokens Int? @map("output_tokens")`
> on the `AgentCallRecord` model). Two int4
> values summed stay int4 and would raise `integer out of range` if the sum
> exceeds 2,147,483,647 — failing the whole tx. The cast makes the sum a bigint;
> realistic per-turn values are far smaller, but the cast costs nothing and removes
> the pathological-overflow foot-gun.
>
> **Why `AND` across the whole watermark group (including the `IS NULL` branch):**
> the guard applies even to legacy rows whose `last_capture_watermark_end IS NULL`
> — those can no longer be token-shrunk either. That is intended defense-in-depth;
> a legacy row with 0/NULL tokens still updates freely (`x ≥ 0`).

The SET list, the RETURNING list, and the `(xmax = 0) AS inserted` flag are
**unchanged**. A shrink-rejected row is simply absent from RETURNING — exactly like
a watermark-rejected row — so it never enters `newlySuccessTriggers`, and the
orchestration trigger fan-out code needs **no change**.

> **Intended consequence (flagged for the reviewer):** the guard suppresses one transition
> trigger that the watermark gate ALONE would fire. A watermark-advancing re-emit that would
> flip an INCOMPLETE/ABORTED row to SUCCESS while carrying **fewer positive** input+output
> tokens than the stored row is refused outright, so the row holds its current state and the
> would-be SUCCESS trigger does not fire. This is **intended**, not a regression: you do not
> want to transition a turn to a "completed" state derived from a smaller, corrupt window.
> In practice this is low-risk because INCOMPLETE/ABORTED rows almost always carry null/zero
> tokens (so `0 >= 0` lets the SUCCESS write through normally). The "no spurious trigger" half
> is unconditional; the "no missed legitimate trigger" half holds for every realistic case but
> not for the contrived shrinking-SUCCESS shape, which is correctly suppressed.

### 3.2 Widen the prior-status pre-SELECT to carry token + watermark state

Find the pre-SELECT block (verified at lines 348-352):

```ts
    const ids = deduped.map((r) => r.id);
    const priorRows = await tx.$queryRaw<
      Array<{ id: string; status: string }>
    >`SELECT id, status FROM agent_call_records WHERE id IN (${Prisma.join(ids)})`;
    const priorStatusById = new Map(priorRows.map((p) => [p.id, p.status]));
```

Replace with:

```ts
    const ids = deduped.map((r) => r.id);
    const priorRows = await tx.$queryRaw<
      Array<{
        id: string;
        status: string;
        input_tokens: number | null;
        output_tokens: number | null;
        last_capture_watermark_end: bigint | null;
      }>
    >`SELECT id, status, input_tokens, output_tokens, last_capture_watermark_end FROM agent_call_records WHERE id IN (${Prisma.join(ids)})`;
    const priorStatusById = new Map(priorRows.map((p) => [p.id, p.status]));
    const priorRowById = new Map(priorRows.map((p) => [p.id, p]));
```

> Types are exact: `input_tokens` / `output_tokens` are `Int?` ⇒ Prisma
> `$queryRaw` yields `number | null`; `last_capture_watermark_end` is `BigInt?` ⇒
> `bigint | null` (verified `schema.prisma:1087-1088` for the token columns and
> `schema.prisma:1129` for `lastCaptureWatermarkEnd BigInt? @map("last_capture_watermark_end")`,
> all on the `AgentCallRecord` model; independently corroborated by
> `build-scalar-spine.ts`'s `AgentCallRecordRowInput`, where `inputTokens`/`outputTokens`
> are `number | null` and `lastCaptureWatermarkEnd` is `bigint | null`). No cast, no `any`.
> This is still ONE round-trip — you are widening the existing SELECT, not adding a statement.

### 3.3 Emit the shrink-rejection metric (accumulate, emit once per agent)

Insert this block **immediately after** the `priorRowById` line you just added and
**before** the timezone-resolution comment/call (verified the next existing lines
are the `// Resolve the IANA timezone …` comment + `await this.resolveAndInjectTimezones(tx, flat);`
at lines 354-357). `flat` is already built above (verified at line 280); `Logger`
is already imported from the barrel (verified at line 58):

```ts
    // Shrink-guard observability. The DO UPDATE WHERE refuses a watermark-
    // advancing write whose (input + output) tokens would strictly shrink the
    // stored row (the Codex task_started re-attach is the live trigger). Count,
    // per agent, the rows this guard vetoes that the watermark gate ALONE would
    // have allowed, so the rejected population is sizeable in prod. This mirrors
    // the SQL predicate exactly — same prior state from the advisory-locked
    // pre-SELECT above, same EXCLUDED values from `flat`. Accumulate then emit
    // once per agent (never per row) per the hot-loop logging discipline.
    const shrinkRejectedByAgent = new Map<string, number>();
    for (const row of flat) {
      const prior = priorRowById.get(row.id);
      if (prior === undefined) continue; // net-new insert — nothing to shrink
      const watermarkAllows =
        prior.last_capture_watermark_end === null ||
        (row.lastCaptureWatermarkEnd !== null &&
          row.lastCaptureWatermarkEnd > prior.last_capture_watermark_end);
      if (!watermarkAllows) continue; // vetoed by watermark, not the shrink guard
      const excludedTokens = (row.inputTokens ?? 0) + (row.outputTokens ?? 0);
      const existingTokens =
        (prior.input_tokens ?? 0) + (prior.output_tokens ?? 0);
      if (excludedTokens < existingTokens) {
        shrinkRejectedByAgent.set(
          row.agent,
          (shrinkRejectedByAgent.get(row.agent) ?? 0) + 1,
        );
      }
    }
    for (const [agent, count] of shrinkRejectedByAgent) {
      Logger.metric('agent_gateway_parse_shrink_rejected_total', count, {
        agent,
      });
    }
```

> **Keep this inline in `batchUpsertRecords` — do NOT extract a private method.**
> The class-shape unit test at spec line 615-636 asserts the prototype methods are
> exactly `{constructor, batchUpsertRecords, resolveAndInjectTimezones,
> upsertChunk}`; adding a method breaks it.
>
> **Type note:** inside the right operand of the `||`, TS narrows
> `prior.last_capture_watermark_end` to non-null (the `=== null` check was false),
> so `row.lastCaptureWatermarkEnd > prior.last_capture_watermark_end` is
> `bigint > bigint` — sound, no cast. The `?? 0` keeps token math in `number`
> (safe to 2^53; these are int4-bounded). `agent` is a bounded label (4 parsers),
> compliant with the metric label discipline.

> **DECISION (flagged for the reviewer) — metric-only, no per-row WARN.** The spec
> says "emit a metric/log." Emit ONLY the accumulated per-agent counter, not a
> per-row `Logger.service.warn`: a per-iteration log in a loop driven by input size
> violates the hot-loop logging rule (`ai/rules/observability/logger-import.md`) —
> it double-emits to stdout + OTLP and can wedge the event loop on a pathological
> batch. A single per-call summary WARN (gated on `shrinkRejectedByAgent.size > 0`)
> would be O(1)-per-tick and is acceptable if the reviewer wants human-readable
> detail, but the counter alone satisfies the acceptance criteria with the lowest
> blast radius. Recommendation: ship metric-only.

### 3.4 Register the metric — `src/telemetry/metric-kind-registry.ts`

A `Logger.metric(name, …)` whose `name` is not in `METRIC_KIND_REGISTRY` is
silently dropped from the OTLP/Grafana pipeline (rule
`ai/rules/observability/metric-kind-registry.md`). It is a **counter** (monotonic
`+N` per batch). In the `// --- agent_gateway ---` block, the entries are
alphabetical; insert immediately **after** `agent_gateway_parse_record_dedup_total:
'counter',` (verified at line 118) and before the
`agent_gateway_parse_state_advance_skipped_total` comment block:

```ts
    agent_gateway_parse_record_dedup_total: 'counter',
    // Verified: per-batch count of DO UPDATE writes refused by the upsert
    // shrink-guard (watermark advanced but input+output tokens would strictly
    // shrink the stored turn), value = N per agent → counter
    agent_gateway_parse_shrink_rejected_total: 'counter',
```

> This is enforced, not optional: `src/telemetry/tests/metric-kind-registry.spec.ts:33-40`
> scans every non-test `src/**.ts` for `Logger.metric('<name>'` and fails if any
> emitted name is missing from the registry. (Note: the
> `ai/rules/observability/metric-kind-registry.md` rule text calls producer-side
> completeness "a future hardening" — that is **stale**; the spec already enforces
> it. Run that spec after adding the metric; see §5.)

### 3.5 Refresh the class docstring (describe current behavior)

The "BLAST-RADIUS NOTE" docstring (verified at lines 32-41) currently states the
gate "only checks the watermark, not per-column quality." After §3.1 that is no
longer the whole story. Rewrite the NOTE to describe the **current** behavior
(no "previously" / "now" language). Replace the block at lines 32-41:

```
 * BLAST-RADIUS NOTE: the SET list is now 35 columns wide (was ~12
 * before scalar promotion). The gate only checks the watermark, not
 * per-column quality. If a parser regression emits a wider-watermark
 * row with NULL where prod had values, the gate fires and the SET
 * overwrites those values with NULL. The watermark precondition still
 * holds (you only lose to a STRICTLY newer capture), but the column
 * count widens the blast radius of a same-window parser-version-bump
 * regression. Mitigation: per-parser invariant tests + the
 * `processChatWithLock` parser-version skip below. Note: `timezone` is
 * exempt from this blast radius (insert-only, gate does not touch it).
```

with:

```
 * BLAST-RADIUS NOTE: the SET list spans ~35 columns. The DO UPDATE gate
 * is two ANDed conditions — (1) watermark monotonicity (you only lose to
 * a STRICTLY newer capture) and (2) a token shrink-guard that refuses a
 * watermark-advancing write whose (input + output) tokens would strictly
 * shrink the stored turn (NULLs as 0). Together they stop a smaller-window
 * re-emit (e.g. a Codex task_started re-attach, or a null-usage idle touch)
 * from clobbering the 4 token columns AND the ~30 content columns of a
 * fuller, finalized turn. The shrink-guard rejects the WHOLE row, so a
 * genuinely larger re-parse still wins and equal-token re-parses still
 * update content/lineage. Rejected rows are counted per agent via
 * `agent_gateway_parse_shrink_rejected_total`. Note: `timezone` is exempt
 * from the gate entirely (insert-only; see below).
```

---

## 4. Tests

### 4.1 REQUIRED fix — `isPriorSelectCall` helper (or existing unit tests break)

In `src/agent-gateway/parse/tests/parse-batch-upsert.service.spec.ts`, the helper
that classifies the pre-SELECT call matches the *exact* old column list (verified
at lines 84-89):

```ts
function isPriorSelectCall(call: QueryRawCall): boolean {
  const first = call[0];
  if (!Array.isArray(first)) return false;
  const sql = (first as unknown as TemplateStringsArray).join('?');
  return /SELECT\s+id,\s+status\s+FROM\s+agent_call_records/i.test(sql);
}
```

Your §3.2 widening inserts columns between `status` and `FROM`, so
`\s+FROM` no longer matches and `priorSelectCallCountOf` returns 0 — breaking
e.g. the `…expect(priorSelectCallCountOf(tx)).toBe(1)` assertions (spec lines 143,
380). Change only the regex to allow the extra columns:

```ts
  return /SELECT\s+id,\s+status[\s\S]*?FROM\s+agent_call_records/i.test(sql);
}
```

> This still won't match the INSERT (it has `RETURNING agent_call_records.id AS
> id`, never `SELECT id, status`) nor the timezone `Prisma.sql` call (its `call[0]`
> is a `Prisma.Sql`, not an array — `isPriorSelectCall` returns false before the
> regex). No other helper changes are needed.

### 4.2 Unit tests to ADD (same spec file)

Add these inside the `describe('ParseBatchUpsertService', …)` block. They reuse the
file's existing `makeRecord`, `upsertCallOf`, `QueryRawCall`, `isPriorSelectCall`,
and `isUpsertCall` helpers. The metric assertions mirror the existing
dedup-metric test (spec lines 417-424): spy on `console.log` (that is where
`Logger.metric` writes — verified `logging.util.ts:403-419`) and filter for the
metric name.

**(a) The SQL carries the shrink guard (defense-in-depth invariant):**

```ts
  it('SQL includes the token-shrink guard ANDed onto the watermark gate in the DO UPDATE WHERE', () => {
    return service
      .batchUpsertRecords(tx as never, [makeRecord()])
      .then(() => {
        const call = upsertCallOf(tx);
        const sql = (call[0] as TemplateStringsArray).join('?');
        // Watermark gate preserved …
        expect(sql).toContain(
          'EXCLUDED.last_capture_watermark_end > agent_call_records.last_capture_watermark_end',
        );
        // … AND the token non-shrink clause guards the same UPDATE.
        expect(sql).toContain('COALESCE(EXCLUDED.input_tokens, 0)');
        expect(sql).toContain('COALESCE(EXCLUDED.output_tokens, 0)');
        expect(sql).toContain('COALESCE(agent_call_records.input_tokens, 0)');
        expect(sql).toContain('COALESCE(agent_call_records.output_tokens, 0)');
        expect(sql).toContain('>=');
      });
  });
```

> (Write it `async () => { … }` with `await` if you prefer — the existing tests in
> this file use `async`. Shown `.then()` only to be unambiguous about ordering.)

**(b) The widened pre-SELECT fetches token + watermark state:**

```ts
  it('prior-status pre-SELECT also fetches existing tokens and watermark for the shrink guard', async () => {
    await service.batchUpsertRecords(tx as never, [makeRecord()]);
    const preSelect = tx.$queryRaw.mock.calls.find(isPriorSelectCall);
    expect(preSelect).toBeDefined();
    const sql = (preSelect![0] as TemplateStringsArray).join('?');
    expect(sql).toContain('input_tokens');
    expect(sql).toContain('output_tokens');
    expect(sql).toContain('last_capture_watermark_end');
  });
```

**(c) Metric fires on a watermark-advancing strict shrink:**

```ts
  it('emits agent_gateway_parse_shrink_rejected_total when a watermark-advancing write strictly shrinks the turn tokens', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const customTx = {
      $queryRaw: vi.fn(async (...args: unknown[]) => {
        const call = args as QueryRawCall;
        if (isPriorSelectCall(call)) {
          return [
            {
              id: 'rec-shrink',
              status: 'SUCCESS',
              input_tokens: 1000,
              output_tokens: 500,
              last_capture_watermark_end: 100n,
            },
          ];
        }
        return [];
      }),
    };

    await service.batchUpsertRecords(customTx as never, [
      makeRecord({
        id: 'rec-shrink',
        lastCaptureWatermarkEnd: 200n, // watermark advances
        result: {
          content: [],
          final_text: null,
          stop_reason: null,
          usage: {
            input_tokens: 10,
            output_tokens: 5, // 15 << 1500 → strict shrink
            tokens_are_estimated: false,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            service_tier: null,
            thread_cumulative_tokens: null,
          },
          timestamp: null,
        },
      }),
    ]);

    const metricLines = logSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((s: string) =>
        s.includes('agent_gateway_parse_shrink_rejected_total'),
      );
    expect(metricLines).toHaveLength(1);
    expect(metricLines[0]).toContain('value=1');
    expect(metricLines[0]).toContain('agent=CLAUDE_CODE');
    logSpy.mockRestore();
  });
```

**(d) No metric when tokens grow or hold (legitimate larger re-parse):**

```ts
  it('does not emit the shrink metric when the write grows the turn tokens', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const customTx = {
      $queryRaw: vi.fn(async (...args: unknown[]) => {
        const call = args as QueryRawCall;
        if (isPriorSelectCall(call)) {
          return [
            {
              id: 'rec-grow',
              status: 'SUCCESS',
              input_tokens: 10,
              output_tokens: 5,
              last_capture_watermark_end: 100n,
            },
          ];
        }
        return [];
      }),
    };

    await service.batchUpsertRecords(customTx as never, [
      makeRecord({
        id: 'rec-grow',
        lastCaptureWatermarkEnd: 200n,
        result: {
          content: [],
          final_text: null,
          stop_reason: null,
          usage: {
            input_tokens: 1000,
            output_tokens: 500,
            tokens_are_estimated: false,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            service_tier: null,
            thread_cumulative_tokens: null,
          },
          timestamp: null,
        },
      }),
    ]);

    const metricLines = logSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((s: string) =>
        s.includes('agent_gateway_parse_shrink_rejected_total'),
      );
    expect(metricLines).toHaveLength(0);
    logSpy.mockRestore();
  });
```

**(e) Attribution — a shrink the watermark gate already vetoes is NOT counted:**

```ts
  it('does not attribute a shrink to the guard when the watermark gate already vetoes the write', async () => {
    // EXCLUDED watermark (200) is NOT greater than existing (300) → the
    // watermark gate rejects first; the shrink metric must not double-count it.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const customTx = {
      $queryRaw: vi.fn(async (...args: unknown[]) => {
        const call = args as QueryRawCall;
        if (isPriorSelectCall(call)) {
          return [
            {
              id: 'rec-old-wm',
              status: 'SUCCESS',
              input_tokens: 1000,
              output_tokens: 500,
              last_capture_watermark_end: 300n,
            },
          ];
        }
        return [];
      }),
    };

    await service.batchUpsertRecords(customTx as never, [
      makeRecord({
        id: 'rec-old-wm',
        lastCaptureWatermarkEnd: 200n, // does NOT advance
        result: {
          content: [],
          final_text: null,
          stop_reason: null,
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            tokens_are_estimated: false,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            service_tier: null,
            thread_cumulative_tokens: null,
          },
          timestamp: null,
        },
      }),
    ]);

    const metricLines = logSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((s: string) =>
        s.includes('agent_gateway_parse_shrink_rejected_total'),
      );
    expect(metricLines).toHaveLength(0);
    logSpy.mockRestore();
  });
```

**(f) The primary corruption shape — a null-usage re-emit (tokens NULL → 0) over a positive-token row fires the metric:**

```ts
  it('emits the shrink metric when a null-usage re-emit lands on a positive-token row (tokens NULL coalesce to 0)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const customTx = {
      $queryRaw: vi.fn(async (...args: unknown[]) => {
        const call = args as QueryRawCall;
        if (isPriorSelectCall(call)) {
          return [
            {
              id: 'rec-null-usage',
              status: 'SUCCESS',
              input_tokens: 1000,
              output_tokens: 500,
              last_capture_watermark_end: 100n,
            },
          ];
        }
        return [];
      }),
    };

    // makeRecord() defaults result.usage to null → input/output_tokens NULL →
    // COALESCE 0, which is the real-world null-usage idle-touch corruption shape.
    await service.batchUpsertRecords(customTx as never, [
      makeRecord({ id: 'rec-null-usage', lastCaptureWatermarkEnd: 200n }),
    ]);

    const metricLines = logSpy.mock.calls
      .map((c: unknown[]) => String(c[0]))
      .filter((s: string) =>
        s.includes('agent_gateway_parse_shrink_rejected_total'),
      );
    expect(metricLines).toHaveLength(1);
    expect(metricLines[0]).toContain('value=1');
    logSpy.mockRestore();
  });
```

> The existing unit tests stay green: all use `makeRecord()` with `result.usage =
> null` → token columns NULL → the guard's `0 >= 0` always holds, so the SQL-shape
> assertions and call-count assertions are unaffected. Only §4.1's regex needed
> editing. The "uses tx.$queryRaw … 3 calls" test (spec lines 267-281) still
> observes exactly 3 calls — the widened pre-SELECT is still one statement.

### 4.3 Integration tests to ADD (real Postgres)

These prove the guard against a live DB — the only place the `WHERE` actually
executes. File:
`src/agents/orchestration/tests/parse-batch-upsert-returning-xmax.int-spec.ts`.

**First, extend the fixture so a test can set token usage.** In
`src/agents/orchestration/tests/fixtures/acr-seed.fixture.ts`:

1. Add `AgentUsageType` to the existing type import (it currently imports
   `AgentResultRecord`, `ParsedAgentCallRecord` from `'../../../../types/agent_call_record'`):

   ```ts
   import type {
     AgentResultRecord,
     AgentUsageType,
     ParsedAgentCallRecord,
   } from '../../../../types/agent_call_record';
   ```

2. Add an optional field to `MakeRecordOpts`:

   ```ts
     readonly usage?: AgentUsageType | null;
   ```

3. In `makeParsedRecord`, change the result's `usage: null` line to honor the opt:

   ```ts
     const result: AgentResultRecord = {
       content: [],
       final_text: null,
       stop_reason: null,
       usage: opts.usage ?? null,
       timestamp: null,
     };
   ```

   (Backward-compatible: existing callers pass no `usage`, so it stays `null`.)

**Then add these cases** inside the `describe(… 'RETURNING (xmax = 0) integration', …)`
block. Define a small local helper for usage inside the describe (or inline it):

```ts
  function usage(input: number, output: number): AgentUsageType {
    return {
      input_tokens: input,
      output_tokens: output,
      tokens_are_estimated: false,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      service_tier: null,
      thread_cumulative_tokens: null,
    };
  }
```

(Import `AgentUsageType` at the top of the int-spec from
`'../../../types/agent_call_record'`.)

**(a) Higher-watermark strict shrink is refused; tokens AND content preserved:**

```ts
  it('refuses a higher-watermark re-emit that strictly shrinks tokens — token and content columns preserved', async () => {
    if (!infraAvailable) return;
    const { userId, captureId } = await seed();

    const big = makeParsedRecord({
      userId,
      captureId,
      watermarkEnd: 100n,
      usage: usage(1000, 500),
    });
    big.result.final_text = 'the full answer';
    big.result.stop_reason = 'completed';

    await prisma.$transaction((tx) => service.batchUpsertRecords(tx, [big]));

    // Same id, HIGHER watermark, SMALLER tokens, nulled content.
    const wider = await seedRawCapture(prisma, { userId, watermarkEnd: 200n });
    const shrunk = makeParsedRecord({
      userId,
      captureId: wider.id,
      watermarkEnd: 200n,
      id: big.id,
      chatId: big.chatId,
      turnId: big.turnId,
      usage: usage(10, 5),
    });
    shrunk.result.final_text = null;
    shrunk.result.stop_reason = null;

    const result = await prisma.$transaction((tx) =>
      service.batchUpsertRecords(tx, [shrunk]),
    );
    // Whole UPDATE vetoed → row absent from RETURNING → no trigger.
    expect(result.newlySuccessTriggers).toHaveLength(0);

    const dbRow = await prisma.agentCallRecord.findUnique({
      where: { id: big.id },
    });
    expect(dbRow?.inputTokens).toBe(1000); // preserved
    expect(dbRow?.outputTokens).toBe(500); // preserved
    expect(dbRow?.finalText).toBe('the full answer'); // content preserved
    expect(dbRow?.stopReason).toBe('completed');
    expect(dbRow?.lastCaptureWatermarkEnd).toEqual(100n); // write fully refused
  });
```

**(b) Higher-watermark growth still wins (legitimate larger re-parse):**

```ts
  it('applies a higher-watermark re-emit when tokens grow (legitimate larger re-parse wins)', async () => {
    if (!infraAvailable) return;
    const { userId, captureId } = await seed();

    const small = makeParsedRecord({
      userId,
      captureId,
      watermarkEnd: 100n,
      usage: usage(10, 5),
    });
    await prisma.$transaction((tx) => service.batchUpsertRecords(tx, [small]));

    const wider = await seedRawCapture(prisma, { userId, watermarkEnd: 200n });
    const grown = makeParsedRecord({
      userId,
      captureId: wider.id,
      watermarkEnd: 200n,
      id: small.id,
      chatId: small.chatId,
      turnId: small.turnId,
      usage: usage(1000, 500),
    });

    const result = await prisma.$transaction((tx) =>
      service.batchUpsertRecords(tx, [grown]),
    );
    expect(result.newlySuccessTriggers).toHaveLength(0); // update path → no trigger

    const dbRow = await prisma.agentCallRecord.findUnique({
      where: { id: small.id },
    });
    expect(dbRow?.inputTokens).toBe(1000); // grew
    expect(dbRow?.outputTokens).toBe(500);
    expect(dbRow?.lastCaptureWatermarkEnd).toEqual(200n); // advanced
  });
```

**(c) Equal-tokens, higher-watermark still updates content (the `>=` boundary):**

```ts
  it('applies a higher-watermark re-emit with equal tokens but fuller content (>= boundary)', async () => {
    if (!infraAvailable) return;
    const { userId, captureId } = await seed();

    const v1 = makeParsedRecord({
      userId,
      captureId,
      watermarkEnd: 100n,
      usage: usage(1000, 500),
    });
    v1.result.final_text = null;
    await prisma.$transaction((tx) => service.batchUpsertRecords(tx, [v1]));

    const wider = await seedRawCapture(prisma, { userId, watermarkEnd: 200n });
    const v2 = makeParsedRecord({
      userId,
      captureId: wider.id,
      watermarkEnd: 200n,
      id: v1.id,
      chatId: v1.chatId,
      turnId: v1.turnId,
      usage: usage(1000, 500), // equal tokens
    });
    v2.result.final_text = 'closing summary';

    await prisma.$transaction((tx) => service.batchUpsertRecords(tx, [v2]));

    const dbRow = await prisma.agentCallRecord.findUnique({
      where: { id: v1.id },
    });
    expect(dbRow?.finalText).toBe('closing summary'); // content updated
    expect(dbRow?.lastCaptureWatermarkEnd).toEqual(200n);
  });
```

**(d) The primary corruption shape on real PG — a higher-watermark null-usage idle touch over a positive-token row is refused:**

```ts
  it('refuses a higher-watermark null-usage idle touch over a positive-token row — tokens and content preserved', async () => {
    if (!infraAvailable) return;
    const { userId, captureId } = await seed();

    const finalized = makeParsedRecord({
      userId,
      captureId,
      watermarkEnd: 100n,
      usage: usage(1000, 500),
    });
    finalized.result.final_text = 'the full answer';
    finalized.result.stop_reason = 'completed';
    await prisma.$transaction((tx) =>
      service.batchUpsertRecords(tx, [finalized]),
    );

    // A null-usage re-emit (idle touch) with a HIGHER watermark: no `usage` opt →
    // result.usage stays null → input/output_tokens NULL → COALESCE 0.
    const wider = await seedRawCapture(prisma, { userId, watermarkEnd: 200n });
    const nullUsage = makeParsedRecord({
      userId,
      captureId: wider.id,
      watermarkEnd: 200n,
      id: finalized.id,
      chatId: finalized.chatId,
      turnId: finalized.turnId,
    });

    const result = await prisma.$transaction((tx) =>
      service.batchUpsertRecords(tx, [nullUsage]),
    );
    // Whole UPDATE vetoed (0 < 1500) → row absent from RETURNING → no trigger.
    expect(result.newlySuccessTriggers).toHaveLength(0);

    const dbRow = await prisma.agentCallRecord.findUnique({
      where: { id: finalized.id },
    });
    expect(dbRow?.inputTokens).toBe(1000); // preserved
    expect(dbRow?.outputTokens).toBe(500); // preserved
    expect(dbRow?.finalText).toBe('the full answer'); // content preserved
    expect(dbRow?.lastCaptureWatermarkEnd).toEqual(100n); // write fully refused
  });
```

> Equal-watermark idempotency (spec criterion "Equal-watermark re-parse → no
> update") is already guaranteed by the **strict** `>` in the watermark gate and is
> covered by the existing `filtered conflict (existing watermark >= EXCLUDED)`
> integration test (int-spec lines 144-183) — no new test needed there.
>
> Every EXISTING integration test stays green: they all seed with `usage = null`
> (token columns NULL → `0 >= 0` always true), so the guard never changes their
> outcomes.

---

## 5. Execution order & commands

1. Edit `parse-batch-upsert.service.ts` (§3.1 SQL `WHERE`, §3.2 pre-SELECT, §3.3
   metric, §3.5 docstring).
2. Register the metric in `metric-kind-registry.ts` (§3.4).
3. Fix the `isPriorSelectCall` regex (§4.1) and add the unit tests (§4.2).
4. Extend the fixture + add the integration cases (§4.3).
5. Run, in order:

   ```bash
   bun run typecheck
   bun run test:unit src/agent-gateway/parse/tests/parse-batch-upsert.service.spec.ts
   bun run test:unit src/telemetry/tests/metric-kind-registry.spec.ts
   ```

   The `metric-kind-registry.spec.ts` run is the gate that proves the new
   `Logger.metric` name is registered (it scans `src/` for emitted names).

6. Integration (requires the proxai-ops Docker Postgres up; if it is not, the
   `.int-spec.ts` cases self-skip via `if (!infraAvailable) return`, so at minimum
   confirm they compile + lint):

   ```bash
   bun run test:integration:vitest src/agents/orchestration/tests/parse-batch-upsert-returning-xmax.int-spec.ts
   ```

Do **not** run `bun run validate` while iterating. If a command fails, fix the
cause — never silence it with a suppression or an `any`.

---

## 6. Audit / self-check greps (run before hand-back)

```bash
cd proxai_nest

# (1) Shrink guard present in the ON CONFLICT WHERE (orchestrator quick-check):
grep -n "COALESCE(EXCLUDED.input_tokens" \
  src/agent-gateway/parse/services/parse-batch-upsert.service.ts
#  → expect the COALESCE(...)::bigint >= COALESCE(...) clause.

# (2) Watermark gate STILL present (you only ADD, never remove it):
grep -n "EXCLUDED.last_capture_watermark_end > agent_call_records" \
  src/agent-gateway/parse/services/parse-batch-upsert.service.ts

# (3) Pre-SELECT widened to carry tokens + watermark:
grep -n "input_tokens, output_tokens, last_capture_watermark_end" \
  src/agent-gateway/parse/services/parse-batch-upsert.service.ts

# (4) Metric produced AND registered (both files must hit):
grep -rn "agent_gateway_parse_shrink_rejected_total" \
  src/agent-gateway/parse/services/parse-batch-upsert.service.ts \
  src/telemetry/metric-kind-registry.ts

# (5) No new private method (class-shape invariant): the metric loop is inline:
grep -n "private async\|private " \
  src/agent-gateway/parse/services/parse-batch-upsert.service.ts
#  → still only resolveAndInjectTimezones + upsertChunk.

# (6) No any / no suppressions IN YOUR DIFF. Scope this to the lines YOU added —
#     `git diff` first, then grep — because the int-spec ALREADY contains a
#     pre-existing `// eslint-disable-next-line no-console` at
#     parse-batch-upsert-returning-xmax.int-spec.ts:87 (inside the existing
#     `beforeEach`, guarding the `console.warn` skip message on the next line —
#     UNRELATED to this phase). A whole-file grep would surface that line. Do NOT
#     remove it (that would re-trigger a no-console lint error on the console.warn
#     it guards); it is out of scope. Your ADDED lines must contain none of these
#     patterns:
git diff -- \
  src/agent-gateway/parse/services/parse-batch-upsert.service.ts \
  src/agent-gateway/parse/tests/parse-batch-upsert.service.spec.ts \
  src/agents/orchestration/tests/parse-batch-upsert-returning-xmax.int-spec.ts \
  src/agents/orchestration/tests/fixtures/acr-seed.fixture.ts \
  | grep -E '^\+' | grep -E ": any|as any|@ts-|eslint-disable|v8 ignore"
#  → expect no matches (added lines only; the pre-existing int-spec:88 suppression
#    is not part of the `+` diff if you left it untouched, as you must).
```

---

## 7. Hand-back report (send this to the orchestrator / verifier)

1. **Files changed** (path + one line each): the upsert service, the metric
   registry, the unit spec, the int-spec, the int fixture.
2. **The source diff** for `parse-batch-upsert.service.ts` pasted verbatim (SQL
   `WHERE` + widened pre-SELECT + metric block + docstring).
3. **The registry diff** (one line + comment).
4. **Pre-flight re-confirmation (spec acceptance item):** state, in one line, that
   you confirmed the watermark pivot — idle-flush advances the same
   `agent_parse_states.last_processed_watermark` the main parser reads
   (`parse-process-chat.service.ts`), so this guard is **defense-in-depth** and the
   Codex `task_started` re-attach is the live trigger.
5. **Test results:** paste the green output of the two `bun run test:unit` commands
   and `bun run typecheck`. For the integration spec, state whether the Docker
   stack was up (cases ran) or not (compile/lint-only, cases self-skipped).
6. **Confirm the flagged decisions** were implemented as written: shrink-guard
   (reject), **not** merge-usage (§9); `>=` operator; COALESCE NULLs to 0;
   `::bigint` cast; metric-only (no per-row WARN); metric loop inline (no new
   method).
7. **Anything you could not do without an `any` / suppression** — name the type
   friction instead of working around it.

---

## 8. Acceptance criteria (the verifier checks all — mirrors the phase spec)

- [ ] **Pre-flight watermark assumption re-confirmed** and noted in the report
      (defense-in-depth; Codex re-attach is the live trigger).
- [ ] A **smaller-window, higher-watermark re-emit no longer overwrites** token OR
      content columns — proved by integration §4.3(a) (tokens 1000/500 and
      `final_text` preserved; watermark stays 100n).
- [ ] **Legitimate larger re-parses** still win (§4.3(b)) and **equal-watermark
      idempotency** is unaffected (existing `filtered conflict` int-spec test +
      the strict-`>` watermark gate).
- [ ] A **registered metric** exposes rejected shrink-writes:
      `agent_gateway_parse_shrink_rejected_total{agent}` is emitted from the
      service AND present in `METRIC_KIND_REGISTRY`; `metric-kind-registry.spec.ts`
      passes.
- [ ] Unit tests assert: the SQL carries the shrink clause (§4.2a), the pre-SELECT
      is widened (§4.2b), the metric fires on a watermark-advancing shrink (§4.2c),
      does **not** fire on growth (§4.2d), is **not** attributed when the
      watermark gate already vetoes (§4.2e), and **fires on a null-usage re-emit over
      a positive-token row** (§4.2f — the primary corruption shape).
- [ ] Integration §4.3(d): a higher-watermark **null-usage idle touch** over a
      positive-token row is refused; tokens and `final_text` preserved, watermark stays 100n.
- [ ] `typecheck` passes; all touched specs green; no `any`, no suppression
      comments, no before/after references; conventional-commit discipline left to
      the operator.

---

## 9. Out of scope & cross-phase notes

**DECISION (flagged for the reviewer) — reject, not merge.** The phase spec offers
an "alternative/inclusive option: when re-emitting the same `promptId`/`turnId`,
MERGE usage (max or sum) instead of replace." **Do NOT implement merge.** Reasons:
(1) a SQL `GREATEST(EXCLUDED.input, existing.input)` per-column merge would corrupt
the per-turn token semantics (a turn stores the SUM of its distinct billed calls —
ROADMAP "Token semantics"), double-counting on legitimate re-parses; (2)
per-agent token math must NOT live in this shared, agent-agnostic upsert (the
agent transforms belong in each parser's `aggregateUsage` / usage extractor — see
the architecture primer); (3) reject is strictly lower blast radius and fully
satisfies "no overwrite corruption." Ship the shrink-guard reject.

**Do NOT:**

- Touch any parser (`parsers/claude-code|codex|gemini|cursor/`),
  `aggregateUsage`, `build-scalar-spine.ts`, or `src/types/agent_call_record.ts`.
  The guard is purely a `WHERE`/observability change in the shared upsert.
- Change the watermark gate, the SET list, the RETURNING list, the `(xmax = 0) AS
  inserted` flag, the dedup-by-id logic, the import-turn filter, or
  `resolveAndInjectTimezones`. You only AND a clause onto the `WHERE`, widen one
  SELECT, and add one metric.
- Add a schema column, a migration, a new queue, or a new module.
- "Fix" historical rows. This guard is **forward-protective only**. Already-
  corrupted rows are recomputed by **Phase 11** (S3 re-parse) — note it, do nothing
  here.
- Extract the metric loop into a private method (breaks the class-shape spec).

**Cross-phase dependencies:**

- **Depends on:** none. Runs standalone.
- **Phase 5** (Claude Code idle-flush orphan-drop) is *recommended after* this
  phase — this guard is its defense-in-depth backstop.
- **Phase 6** (Codex re-attach parser guard) *depends on* this phase's defense:
  the Codex re-attach is the live trigger this guard catches, and Phase 6 layers a
  parser-side fix on top. Do not pull any Phase 6 parser logic into this phase.
- **Phase 11** (backfill) re-parses S3 to repair pre-guard corruption.
- **Shared file with Phase 9:** `src/telemetry/metric-kind-registry.ts` is also edited by
  Phase 9 (`deterministicRecordId` hardening). Both phases only **add** a new counter entry at
  different alphabetical positions in the `// --- agent_gateway ---` block, so there is no
  logic conflict — but expect a merge touch-point in this file. No ordering dependency: it is
  harmless whichever phase lands first; resolve a merge by keeping both new entries.

---

## 10. Stale spec pointers corrected in this plan (FYI for the reviewer)

- The phase spec cites the upsert at `parse-batch-upsert.service.ts:504-545`.
  Verified: `ON CONFLICT … DO UPDATE SET` begins at **line 504**; token columns are
  **515-518**; the gating `WHERE` is **540-545**; RETURNING is **546-565**. Use the
  **named SQL clause**, not the numbers, if they drift.
- The `ai/rules/observability/metric-kind-registry.md` rule states producer-side
  completeness ("grep every `Logger.metric` call site and assert each name is a
  registry key") is "a future hardening … until that exists, this rule is the
  guard." **Stale** — `src/telemetry/tests/metric-kind-registry.spec.ts:33-40`
  already implements exactly that scan. Your new metric MUST be registered or that
  spec fails (which is the desired gate).
