# Phase 11 — Implementation Instructions (for the implementer + operator pair)

> **Audience:** the ops/implementer model that PREPARES and DRY-RUNS the backfill, plus the
> **OPERATOR** who runs the production writes. This phase is operator-run: the agent edits +
> dry-runs; the operator executes every prod-mutating command.
> **Author:** orchestrator chat (source-verified against `proxai_nest` on 2026-06-17 — every
> `file:line` below was read from disk, NOT recalled).
> **Companion specs (already settled — do not re-open):**
> `../phase-11-prod-data-backfill.md`, `../ROADMAP.md` ("Backfillability of historical data" +
> "Decisions LOCKED"), `../analysis/VERIFICATION_FINDINGS.md` §11.
>
> Everything you need is here. If line numbers have drifted, trust the **named symbol**
> (function / file / column), not the line number, and apply the change at the symbol.
>
> **This phase is `proxai_nest` ONLY** (a re-parse invocation + a small batching flag). No
> gateway change. No schema/migration change. The corrected PARSER logic ships in Phases 2,
> 3, 5, 7 — Phase 11 only re-feeds existing S3 captures through that already-deployed logic.

---

## 0. TL;DR — what you are doing

Historical prod `agent_call_records` (ACRs) were computed by the OLD buggy parser logic.
Phases 2/3/5/7 fix the logic **forward**. Phase 11 corrects the **past** by re-feeding every
existing S3 capture for the affected agents (**gemini, CODEX, CLAUDE_CODE, CLAUDE_DESKTOP**)
through the now-fixed pipeline. The re-parse re-derives each ACR with the same deterministic
`id`, so corrected rows land in place — **but only if the upsert's watermark shrink-guard
permits it** (this is the load-bearing gotcha — see §2 and §3).

The mechanism already exists and is operator-only: **`ai/tools/version-drift/reparse-chats.ts`**
(verified at `proxai_nest/ai/tools/version-drift/reparse-chats.ts:1-479`). It clears the
`AgentParseState` cursor for matching chats and enqueues one `agent-parse` job per file; the
live parse workers re-derive ACRs and write them through the gated batch upsert.

**Your deliverables:**
1. **(implementer, code)** Add an optional `--limit=N` batching flag to the existing
   reparse path so the operator can chunk "ALL history" into throttled batches (§4). Small,
   pure-args change + one slice in the script + unit specs. This is the only source change.
2. **(implementer, prep)** Produce the exact per-agent dry-run + execute runbook (§5), the
   shrink-guard decision writeup (§3), and a verification query set (§7).
3. **(OPERATOR, prod)** Run the dry-runs, decide the heal strategy (§3), run the live backfill
   in batches, spot-check (§7). The agent NEVER runs the prod writes.

**The one permanent gap (state this loudly to stakeholders BEFORE running):** **F1 (Claude
Code gateway dialogue-filter drop, Phase 1) is NOT backfillable.** Those usage-bearing
tool_use records were dropped at the gateway **before S3 upload**, so re-parsing the S3
captures cannot recover them. Only Claude Code captures taken **after Phase 1 shipped** are
correct. Re-parsing CLAUDE_CODE history still helps the **idle-flush orphan-drop (Phase 5)**
recovery (those continuation records ARE in S3), but the dialogue-filter under-count is gone
forever. (Source: `../ROADMAP.md` "Backfillability of historical data"; reconfirmed against
the gateway's own fixture in `VERIFICATION_FINDINGS.md` §10.6.)

---

## 1. Hard rules (non-negotiable — enforced by lint/CI/reviewers AND by operator discipline)

- **No `any`** — not `: any`, `as any`, `Promise<any>`, `Record<string, any>`, or implicit
  any, in source **or** `.spec.ts`. Use `unknown` + a type guard at boundaries. If a 3rd-party
  type forces an any, **stop and report it** — never silently insert one.
- **No suppression comments** — `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`,
  `eslint-disable`, `oxlint-disable`, `v8 ignore`. Fix the type instead.
- **No "before/after" references** in code, comments, or test names. Describe **current**
  behavior only (`it('caps enqueue at the --limit value', …)`, never "no longer enqueues all").
- **Comments explain *why*,** not *what*. No banners.
- **No hardcoded enum strings.** Reference the imported const-objects (`AgentAppNames`,
  `REPARSE_EXIT_CODES`, the queue-name + status constants). The script already follows this —
  do not regress it.
- **Package manager is `bun`.** Nest tests run via **`bun run test:unit <path>`** (never raw
  `vitest`). Typecheck via `bun run typecheck`. **Do NOT run `bun run validate`** while
  iterating — run it once at the end.
- **New `Logger.metric(name, …)` names MUST be registered** in
  `src/telemetry/metric-kind-registry.ts` (`METRIC_KIND_REGISTRY`). An existing spec scans
  `src/` and fails on unregistered names. *Phase 11 adds no `Logger.metric` calls — the
  reparse script uses `process.stdout.write`, not the Logger — so this rule is unlikely to
  bite. If you add ANY metric, register it.*
- **No per-record / per-line / per-turn `Logger.metric` or `Logger.service.*` calls** — the
  2026-06-10 hot-loop incident. Accumulate via `ExtractorMetricAccumulator.recordEvent` and
  flush once per tick. (Not relevant to the batching flag, but stated because the re-parse
  drives the hot parse pipeline.)
- **Git:** the agent does **not** commit / push / branch / stage unless the operator tells it
  to. Leave edits in the working tree.
- **Destructive-command discipline (LOAD-BEARING for this phase):** the agent **never** runs
  the prod write. `reparse-chats.ts` performs production WRITES (Postgres UPDATE + BullMQ
  enqueue) and any `DELETE` heal step (§3) is raw prod DML — **both are OPERATOR-ONLY** per
  `ai/rules/process/destructive-commands.md`. The hosting dir `ai/tools/version-drift/` is in
  `mapper.config.toml`'s `emit_tools.exclude_subdirs`, so the script is intentionally NOT
  distributed to `.claude/tools/` etc. — agents won't even see it as a callable helper. The
  agent prepares and dry-runs; the operator executes. (Verified: `reparse-chats.ts:32-39`.)

---

## 2. The mental model — READ THIS BEFORE PREPARING ANY COMMAND

### 2.1 How a re-parse actually heals a row

`reparse-chats.ts` does exactly two things per matched chat (verified `reparse-chats.ts:371-433`):

1. **Clears the `AgentParseState` cursor** in one `$transaction` of `agentParseState.update`:
   ```
   accumulatorBlob          → Prisma.DbNull   (force cold accumulator rebuild)
   lastProcessedWatermark   → null            (re-fetch ALL captures from the start)
   lastProcessedCaptureId   → null
   status                   → 'ACTIVE'
   failedReason             → null
   ```
   `parser_version` is deliberately LEFT as-is — the next parse tick rewrites it from the
   deployed parser code (`reparse-chats.ts:371-373`).
2. **Enqueues one `agent-parse` job per unique `(host_id, source_path_hash, agent)`** with
   payload `{ hostId, sourcePathHash, sourceApp }` (`reparse-chats.ts:398-430`). The live
   parse workers (concurrency 4/replica, per-file Redis SETNX gate) pick these up, re-read
   every S3 capture for the file, re-derive the ACR(s) with the deployed (fixed) logic, and
   write them through `ParseBatchUpsertService` (`INSERT … ON CONFLICT (id) DO UPDATE`).

The ACR `id` is `deterministicRecordId = blake2b_128(agent | chat_id | turn_id)` truncated to
32 hex chars (verified `src/agent-gateway/parsers/parsers.utils.ts:47-58`). Same
`(agent, chat_id, turn_id)` → same `id` across re-parses → the re-derived row targets the
SAME row via `ON CONFLICT (id)`. **No double-count: it's UPSERT-REPLACE, never arithmetic SUM.**

### 2.2 ⚠️ The shrink-guard veto — the gotcha the spec under-states

`ParseBatchUpsertService`'s `ON CONFLICT (id) DO UPDATE` carries a WHERE guard
(**verified `src/agent-gateway/parse/services/parse-batch-upsert.service.ts:540-545`**):

```sql
WHERE
  agent_call_records.last_capture_watermark_end IS NULL
  OR (
    EXCLUDED.last_capture_watermark_end IS NOT NULL
    AND EXCLUDED.last_capture_watermark_end > agent_call_records.last_capture_watermark_end
  )
```

This is the **Phase-4 shrink-guard** (anti-corruption: a worker holding a smaller/older
capture window must never clobber a wider-window row). The comparison is **strict `>`**.

`last_capture_watermark_end` is the byte/rowid offset of the last consumed capture
(`schema.prisma` `AgentCallRecord.lastCaptureWatermarkEnd`, "Equals `AgentRawCapture.watermarkEnd`
of `lastCaptureId`"). **The same set of S3 captures always yields the same final watermark.**
So a re-parse of a **dormant chat** (no new captures have arrived since the buggy parse)
re-derives an **equal** `last_capture_watermark_end` → `W > W` is FALSE → **the UPDATE is
vetoed and the corrected token columns are silently NOT written.** No error, no log, no Sentry
— the row whose WHERE clause vetoes the UPDATE is simply absent from `RETURNING`
(`parse-batch-upsert.service.ts:561-565`).

**Consequence the spec mis-states.** The Phase 11 spec and ROADMAP §11.1 say the re-parse
"REPLACEs each row idempotently." That is true ONLY for rows where the re-parse produces a
**strictly larger** watermark:
- **Chats that gained new captures since the buggy parse** (active/growing) → new watermark >
  old → heal lands. ✅
- **CLAUDE_DESKTOP** → currently produces **zero** ACRs (version-prefix short-circuit, see
  `VERIFICATION_FINDINGS.md` §11.2; parse marked `UNSUPPORTED_VERSION` at
  `parse-process-chat.service.ts:125-145`). There is no existing ACR row → the re-parse is a
  fresh **INSERT** (WHERE guard's `IS NULL` arm is irrelevant — there is no conflict row) → it
  populates cleanly. ✅
- **Dormant CODEX / gemini / CLAUDE_CODE chats** (no new captures) → equal watermark → **vetoed
  → NOT healed by naive re-parse.** ✗

**The silent-success trap:** the re-parse will still ADVANCE the `AgentParseState.parser_version`
to the new deployed value (the parse tick rewrites it) and drain the queue with zero errors —
so the operation *looks* complete — while the dormant ACR's token columns stay stale because
the upsert was vetoed. **You cannot trust "the queue drained" as proof of heal. The only proof
is the before/after token spot-check in §7.**

### 2.3 The documented heal for vetoed rows: operator DELETE-then-reparse

`reparse-chats.ts:9-14` documents the canonical **two-step** recovery for exactly this case:

```
//   1. (operator) DELETE FROM agent_call_records WHERE parser_version <= '<BAD>'
//   2. (this script) clear AgentParseState + enqueue → workers re-derive
```

Deleting the stale ACR first means the re-parse INSERTs a fresh row (no conflict → no WHERE
guard → corrected tokens land). **But DELETE has real blast radius** — see §3. The DELETE is
**operator-only raw prod DML** (the implementer must NOT write it into any script; the spec's
"go through the parser/upsert pipeline, do NOT write raw DML" applies to the agent's code).

---

## 3. ⚠️ DECISION REQUIRED before the live run — the heal strategy

Because of §2.2, "naive re-parse heals everything" is **false** for dormant rows. The operator
must pick a heal strategy per agent. Present these three options to the operator/orchestrator
and **get an explicit `go` on one before the live run.** Do not silently assume the spec's
"UPSERT replaces idempotently."

### Option A — DELETE-then-reparse (universal heal, heaviest blast radius)
Operator runs `DELETE FROM agent_call_records WHERE agent = '<AGENT>' AND parser_version < '<NEW>'`
(operator-only raw DML), then `reparse-chats … --execute`. Every affected row re-INSERTs fresh
with corrected tokens, dormant or not.

**Blast radius the operator MUST weigh (source-verified):**
- Deleting an `AgentCallRecord` **cascades to `BreadcrumbRecord`** (`onDelete: Cascade`,
  **verified `schema.prisma:1290`**) — you destroy the breadcrumb agent's CLASSIFICATION rows.
  Those carry an LLM cost to regenerate (`BreadcrumbRecord.generationPriceNanoUsd`,
  `schema.prisma:1248`); whether they auto-regenerate depends on the NEW_ACR outbox re-firing
  for the re-inserted ids (verify before committing to this path).
- `BreadcrumbRecord` also holds **denormalized** ACR token stamps (`acrInputTokens`,
  `acrOutputTokens`, `acrCacheCreationTokens`, `acrCacheReadTokens` — `schema.prisma:1265-1296`)
  that feed `BreadcrumbDailyStat` / project-tracker / team-stats. Healing the ACR does NOT
  refresh these unless the breadcrumb is re-classified or the stats are rebuilt
  (`scripts/rebuild-breadcrumb-local-stats.ts`, `scripts/rebuild-team-stats.ts` exist for this).
- `lastCaptureId` on other captures uses `onDelete: SetNull` (`schema.prisma:1141`) — deleting
  the ACR does NOT touch `agent_raw_captures` (S3 index is preserved). Good.

**Net:** Option A fully heals the **primary** token dashboards (the 7 org-analytics ACR
services + `/agent-call-record-stats` read the ACR token columns DIRECTLY with disjoint
`COALESCE(SUM,0)` — `VERIFICATION_FINDINGS.md` §9), but it sacrifices breadcrumb classification
and the breadcrumb-derived secondary dashboards until rebuilt/re-classified.

### Option B — Naive reparse-only (lightest, partial heal)
Run `reparse-chats … --execute` with NO delete. Heals:
- **CLAUDE_DESKTOP** fully (zero existing rows → fresh INSERT — this is a clean populate). ✅
- Any CODEX/gemini/CLAUDE_CODE chat that **gained new captures** since the buggy parse. ✅
- Leaves **dormant** CODEX/gemini/CLAUDE_CODE rows stale (vetoed). ✗
Preserves all breadcrumbs. Use this if the operator decides the dormant-row correction isn't
worth the breadcrumb blast radius, OR as a strictly-safe first pass (it cannot corrupt
anything — vetoes are no-ops).

### Option C — Add a guarded equal-watermark token-heal path (medium effort, code work)
A scoped `reparse`/`--force-token-heal` mode in `proxai_nest` that allows the upsert to
overwrite **only the token columns** when `EXCLUDED.last_capture_watermark_end ==` the existing
value AND the id matches (id-stable, window-equal). Avoids the breadcrumb cascade. This is real
`proxai_nest` source work (a new guarded upsert branch + tests) beyond "operator runs a script,"
and it must preserve the strict `>` veto for genuinely-smaller windows. Only pursue if the
operator wants dormant-row token correction WITHOUT losing breadcrumbs.

**Recommendation to put in front of the operator:** run **Option B first** for CLAUDE_DESKTOP
(clean, zero-risk populate) and for active chats, confirm via spot-check (§7) how many dormant
rows remain stale, then decide between Option A (accept breadcrumb rebuild) and Option C (build
the guarded heal) for the dormant CODEX/gemini/CLAUDE_CODE remainder. **Do not proceed to any
delete or force-heal without the operator's explicit `go`.**

---

## 4. CHANGE 1 — add a `--limit=N` batching flag (the only source change)

**Why:** the spec mandates the backfill be **batched + throttled** so it doesn't exhaust the
PgBouncer/PM2 connection budget. The live throttle is real but indirect: re-parse jobs run on
the `agent-parse` queue at **concurrency 4/replica** behind a per-file Redis SETNX gate
(`agent-parse.processor.ts:37-40`), and every parse tick's upsert uses a `PrismaService`
connection (`connection_limit=7`/worker; capacity math `replica_count × 16 × 7 ≈ replica × 112`
client conns multiplexed to ~300 PG backends — `.claude/knowledge/deployment/pgbouncer-and-pool-sizing.md`).
The queue is the natural rate-limiter, **but** `reparse-chats.ts` enqueues **every** match in a
single run (`reparse-chats.ts:428-430` — one `queue.add` per file tuple, no cap). For "ALL
history" that can be tens of thousands of jobs at once. A `--limit=N` lets the operator chunk
each run and watch queue depth between batches.

> **What `--limit` actually caps:** the number of matched **chats** (`AgentParseState`
> rows = one per `(agent, chat_id)`) cleared + enqueued. Those chats then collapse to
> unique `(host_id, source_path_hash, agent)` **file tuples** at enqueue, so
> `--limit=500` clears up to 500 chats and enqueues **≤500** file jobs (fewer if
> several matched chats share a file). The throttle is therefore conservative — never
> *more* jobs than the limit.

**Files (all in `proxai_nest`):**
1. `scripts/seed-lib/reparse-chats-args.ts` — add `limit` to `ReparseArgs`, parse `--limit=N`,
   validate it.
2. `ai/tools/version-drift/reparse-chats.ts` — apply the cap to `matches` before enqueue.
3. `scripts/seed-lib/_tests/reparse-chats-args.spec.ts` — extend the existing arg specs.

### 4.1 `reparse-chats-args.ts` — add the field, parse it, validate it

In the `ReparseArgs` interface (`reparse-chats-args.ts:41-50`) add the field. It is
declared **required** (`limit: number | null`, no `?`) to stay consistent with the
`parseArgs` default object below, which always sets `limit: null`. Because it is
required, **two** complete `ReparseArgs` literals must gain a `limit` value: the
`parseArgs` `args` object (patched here) and the `baseArgs` test helper (patched in
§4.3 — do not skip that step, or `bun run typecheck` fails with TS2741).

```ts
  /**
   * Optional cap on how many matched chats this run clears + enqueues.
   * Lets the operator chunk a full-history backfill into throttled batches
   * and watch agent-parse queue depth between runs. Null = no cap (all
   * matched chats).
   *
   * Successive limited runs self-drain regardless of row order: each run
   * re-parses an arbitrary <=N subset, whose AgentParseState rows then have
   * their parser_version rewritten to the deployed value and so drop out of
   * the next run's `parser_version<NEW` match set. (The candidate fetch at
   * reparse-chats.ts uses `findMany({ where })` with NO `orderBy`, so the
   * matched subset is NOT stable/ordered across runs — do not rely on a
   * deterministic (agent, chat_id) ordering; rely only on the parser_version
   * filter shrinking the remainder each pass.)
   */
  limit: number | null;
```

In `parseArgs` set the default `limit: null` in the initial `args` object
(`reparse-chats-args.ts:99-108`) and add a branch in the flag loop (before the unknown-arg
`throw` at `:125-127`):

```ts
    } else if (raw.startsWith('--limit=')) {
      const value = Number(raw.slice('--limit='.length));
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`--limit must be a positive integer, got: ${raw.slice('--limit='.length)}`);
      }
      args.limit = value;
    } else {
```

No `validateArgs` change is required (the parse-time guard above is sufficient and matches the
file's "throw an Error the caller prints + exits argError" convention — `reparse-chats-args.ts:93-97`).

### 4.2 `reparse-chats.ts` — apply the cap before enqueue

In `main`, the matches are computed at `reparse-chats.ts:323`
(`const matches = candidates.filter(filter.matcher);`), and the **existing**
count-line write sits immediately below at `reparse-chats.ts:324-326`:

```ts
    process.stdout.write(
      `reparse-chats: candidates=${candidates.length} matches=${matches.length}\n`,
    );
```

**Replace that existing 324-326 `process.stdout.write` block** (do not leave it in
place and add a second write — that duplicates the `candidates=… matches=…` line)
with the cap + report:

```ts
    const matches = candidates.filter(filter.matcher);
    const limited =
      parsed.limit !== null ? matches.slice(0, parsed.limit) : matches;
    process.stdout.write(
      `reparse-chats: candidates=${candidates.length} matches=${matches.length}` +
        (parsed.limit !== null
          ? ` limited_to=${limited.length} (--limit=${parsed.limit})`
          : '') +
        `\n`,
    );
```

(Keep the `const matches = …` line as-is; the new `const limited = …` line goes
directly after it, then the replacement write.)

Then swap `matches` → `limited` at **every** consumption site below the count line.
These are the exact occurrences (verified line numbers; trust the surrounding code
if they drift):

| Line | Current text | Becomes |
|---|---|---|
| 338 | `const sample = matches.slice(0, 10);` | `const sample = limited.slice(0, 10);` |
| 347 | `if (matches.length > sample.length) {` | `if (limited.length > sample.length) {` |
| 349 | `` `  ...and ${matches.length - sample.length} more\n` `` | `` `  ...and ${limited.length - sample.length} more\n` `` |
| 361 | `const ok = await promptProdConfirm(parsed.env, matches.length);` | `const ok = await promptProdConfirm(parsed.env, limited.length);` |
| 374 | `const ids: … = matches.map(` | `const ids: … = limited.map(` |
| 402 | `for (const m of matches) {` | `for (const m of limited) {` |

Rule of thumb if a line ref drifts: every textual `matches` between the new count
block and the final enqueue loop becomes `limited` — **except** the
`matches.length === 0` early-return guard at `reparse-chats.ts:328` (line 328 stays
keyed on the unlimited `matches`: an empty *match* set is still "nothing to do"; a
non-empty set capped to a non-zero `limited` proceeds — `--limit` can never be 0,
which §4.1's guard rejects).

> Keep the type honest: `parsed.limit` is `number | null` and `Array.prototype.slice` accepts a
> `number` — no cast, no `any`.

> **`--limit` greater than the match count** is harmless: `matches.slice(0, limit)`
> returns the whole array, so `limited_to=` prints `matches.length` (which can be
> *less* than the requested `--limit` — that is expected, not a bug). **`--limit`
> combined with `--chat-id`** (single-chat mode) is also harmless — slicing a
> 1-element set — but pointless; the operator typically uses `--limit` only with a
> `--filter` selector.

### 4.3 `reparse-chats-args.spec.ts` — extend the existing specs

Runner: **`bun run test:unit scripts/seed-lib/_tests/reparse-chats-args.spec.ts`** (Vitest).

**First, fix the typecheck break the required field introduces.** The
`validateArgs` describe block has a `baseArgs` helper that builds a complete typed
`ReparseArgs` literal (`reparse-chats-args.spec.ts:132-144`). Since §4.1 added a
**required** `limit`, this literal no longer satisfies `ReparseArgs` and
`bun run typecheck` fails with `TS2741: Property 'limit' is missing`. Add
`limit: null,` to the `baseArgs` return literal, between `help: false,` and
`...overrides,`:

```ts
    function baseArgs(overrides: Partial<ReparseArgs> = {}): ReparseArgs {
      return {
        env: 'local',
        filter: 'status=ACTIVE',
        chatId: null,
        agent: null,
        dryRun: true,
        execute: false,
        yes: false,
        help: false,
        limit: null,
        ...overrides,
      };
    }
```

Then add to the `parseArgs` describe block:

```ts
  it('parses --limit=N into a positive integer', () => {
    expect(parseArgs(['--env=prod', '--filter=status=ACTIVE', '--limit=500']).limit).toBe(500);
  });

  it('defaults limit to null when --limit is absent', () => {
    expect(parseArgs(['--env=prod', '--filter=status=ACTIVE']).limit).toBeNull();
  });

  it('rejects a non-positive or non-integer --limit', () => {
    expect(() => parseArgs(['--limit=0'])).toThrow('--limit must be a positive integer');
    expect(() => parseArgs(['--limit=-5'])).toThrow('--limit must be a positive integer');
    expect(() => parseArgs(['--limit=abc'])).toThrow('--limit must be a positive integer');
  });
```

> If `reparse-chats.ts:main` has its own spec under `ai/tools/version-drift/tests/`, add a case
> asserting `limited.length === min(limit, matches.length)` only if that test harness already
> stubs Prisma + the BullMQ `Queue` (it must NOT hit a real DB — unit tests mock
> `PrismaService`; integration tests use a real DB via `.test.mjs`). If the existing test file
> doesn't already exercise `main`, do not add a brittle one — the args-level specs above cover
> the flag's contract.

### 4.4 Run the checks (do NOT run `bun run validate` while iterating)

```bash
bun run typecheck
bun run test:unit scripts/seed-lib/_tests/reparse-chats-args.spec.ts
# main() was edited (count block + matches→limited swap), so re-run its spec
# unconditionally — this spec at ai/tools/version-drift/tests/reparse-chats.spec.ts
# already exists and exercises main() heavily. It uses stringContaining for stdout
# and asserts update=2/add=1 on the default null-limit path, so it stays green
# (the change is backward-compatible when --limit is absent).
bun run test:unit ai/tools/version-drift/tests/reparse-chats.spec.ts
```

That is the entire source change. If `--limit` is more than the operator needs, they can omit
it and rely on the queue's `concurrency: 4` + per-file SETNX gate as the sole throttle — but
shipping the flag makes "batched" real and keeps the operator in control.

---

## 5. The backfill runbook (OPERATOR-RUN — exact commands)

> **Ordering prerequisite (LOCKED — ROADMAP "Decisions LOCKED" item 4 + Phase 11 spec
> "Depends on"):** Phases **2, 3, 5, 7** must be **merged and DEPLOYED to the target env**
> before re-parsing — their fixed parser logic must be the code the workers run, or the
> re-parse re-derives the SAME wrong values. Also benefits from 4 (the shrink-guard itself) and
> 6 (Codex re-attach). Confirm the deployed parser version before any run.

### 5.0 Env + safety preconditions

`reparse-chats.ts` resolves its connection URLs (verified `reparse-chats-args.ts:322-360`):
- Postgres: `POSTGRES_URL_MIGRATION_PROD` (preferred) or `POSTGRES_URL_NON_POOLING_PROD`
  (these bypass PgBouncer + runtime timeouts — correct for the bulk parse-state UPDATE).
- Redis: `REDIS_PUBLIC_URL_PROD`.
A **mutex** (`SETNX reparse-chats:running`, 1h TTL — `reparse-chats.ts:81-82, 150-154`) blocks
concurrent runs (exit 9). Prod requires a **typed confirmation** unless `--yes` is passed
(`reparse-chats.ts:173-188, 360-369`). Exit codes: `0` ok, `2` arg, `3` env-missing, `4` no
matches, `5` dry-run-complete, `9` mutex-held (`REPARSE_EXIT_CODES`, `reparse-chats-args.ts:32-39`).

### 5.1 Per-agent selection (verified filter grammar)

The agent enum is `AgentAppNames = ['CLAUDE_CODE','CLAUDE_DESKTOP','CURSOR','CODEX','gemini']`
(**verified `src/agent-gateway/agent-gateway.types.ts:41-47`** — note `gemini` is lowercase by
design; the others are UPPER_SNAKE). The filter grammar (`compileFilter`,
`reparse-chats-args.ts:193-311`) accepts:
`parser_version{<|<=|=}<semver>` · `agent_schema_version=<v>` (dual-signal: failed_reason OR
current capture version) · `status=<S>` (`ACTIVE|PARSE_FAILED|UNSUPPORTED_VERSION|IDLE_FLUSH_ABANDONED|COMPLETED`)
· OR `--chat-id=<id>`.

| Agent | Existing ACRs? | Recommended selector | Heal path |
|---|---|---|---|
| **CLAUDE_DESKTOP** | **none** (UNSUPPORTED_VERSION; zero rows) | `--filter=status=UNSUPPORTED_VERSION --agent=CLAUDE_DESKTOP` | Clean fresh INSERT — naive reparse (Option B). No delete. |
| **CODEX** | yes (over-counted) | `--filter=parser_version<<NEW_CODEX_PARSER_VER> --agent=CODEX` | §3 decision (A/B/C). Dormant rows need Option A/C. |
| **gemini** | yes (phantom cacheCreation) | `--filter=parser_version<<NEW_GEMINI_PARSER_VER> --agent=gemini` | §3 decision (A/B/C). |
| **CLAUDE_CODE** | yes (idle-flush orphan recoverable; F1 NOT) | `--filter=parser_version<<NEW_CC_PARSER_VER> --agent=CLAUDE_CODE` | §3 decision. F1 under-count permanently unrecoverable. |

`parser_version<<NEW>` ("strictly less than the newly-deployed parser version") selects every
chat not yet re-parsed by the fixed code, and is **self-draining/resumable**: as the worker
re-parses, it rewrites `AgentParseState.parser_version` to `<NEW>`, dropping the row out of the
next run's match set. ⚠️ Per §2.2, parser_version advancing on the parse-state does NOT prove
the ACR healed — confirm with §7. (The exact `<NEW>` value is the deployed parser version for
that agent; read it off `parsers.versions.ts` / `parsers.currentVersion(agent)` AFTER the
Phase 2/3/5/7 deploy, or from a `SELECT DISTINCT parser_version` on fresh post-deploy rows.)

### 5.2 Dry-run FIRST, always (every selector, every agent)

Dry-run is the default (no `--execute`) and exits `5`. It prints `candidates=…  matches=…`
(plus `limited_to=…` if `--limit` is set) and a sample of up to 10 matched rows
(`reparse-chats.ts:336-357`). Run all four:

```bash
# CLAUDE_DESKTOP — expect a non-zero match count of UNSUPPORTED_VERSION rows
bun ai/tools/version-drift/reparse-chats.ts --env=prod \
  --filter=status=UNSUPPORTED_VERSION --agent=CLAUDE_DESKTOP

# CODEX / gemini / CLAUDE_CODE — substitute the real deployed <NEW> parser version per agent
bun ai/tools/version-drift/reparse-chats.ts --env=prod \
  --filter='parser_version<<NEW_CODEX_PARSER_VER>' --agent=CODEX
bun ai/tools/version-drift/reparse-chats.ts --env=prod \
  --filter='parser_version<<NEW_GEMINI_PARSER_VER>' --agent=gemini
bun ai/tools/version-drift/reparse-chats.ts --env=prod \
  --filter='parser_version<<NEW_CC_PARSER_VER>' --agent=CLAUDE_CODE
```

**Record the dry-run `matches=` count per agent.** This is the spec's required "sane
change-count report per agent" (acceptance criterion). Sanity-check against the prod row counts
in `VERIFICATION_FINDINGS.md` §1 (gemini ~1,341 · CLAUDE_CODE ~15,463 · CODEX ~1,853 ·
CLAUDE_DESKTOP 0 ACRs but N parse-states).

### 5.3 Execute — batched, one agent at a time, watch queue depth between batches

After the operator picks a heal strategy (§3) and signs off the dry-run counts:

**CLAUDE_DESKTOP (Option B, clean populate — do this one first, lowest risk):**
```bash
bun ai/tools/version-drift/reparse-chats.ts --env=prod \
  --filter=status=UNSUPPORTED_VERSION --agent=CLAUDE_DESKTOP --execute
# (typed prod confirm appears; type the exact phrase it prints)
```

**CODEX / gemini / CLAUDE_CODE — batched with `--limit`:**
```bash
# one batch of up to 500 matched chats (→ ≤500 file jobs); repeat, watching queue depth
bun ai/tools/version-drift/reparse-chats.ts --env=prod \
  --filter='parser_version<<NEW_CODEX_PARSER_VER>' --agent=CODEX \
  --limit=500 --execute
```
Between batches, watch the `agent-parse` queue drain (BullMQ admin / `getJobCounts`) and PG
pressure (`P2024` in Sentry → `bullmq_terminal_failure{errorCode:'P2024_POOL_TIMEOUT'}`;
`pg_stat_activity` near `default_pool_size`). Re-run the same command to pick up the next batch
(`parser_version<<NEW>` self-drains as rows advance). Size the batch and the inter-batch pause
to keep parse-tick concurrency comfortably under the pool budget.

**If the operator chose Option A (DELETE-then-reparse) for the dormant remainder:** the DELETE
is **operator-only raw DML run outside the agent session** (cascades `breadcrumb_records` per
§3 — accept that or rebuild after). The agent does NOT write or run it. After the operator's
DELETE, the same `reparse-chats … --execute` re-INSERTs fresh rows.

---

## 6. Safety + idempotency notes (why batched re-parse is safe)

- **Re-parse is idempotent on the write side**: deterministic ids + UPSERT-REPLACE (never SUM)
  → running a batch twice cannot double-count (`parsers.utils.ts:47-58`;
  `parse-batch-upsert.service.ts:504-545`). The shrink-guard is the safety net against a
  smaller-window re-emit during the backfill.
- **Equal-watermark re-emits are no-ops** (vetoed) — so an accidental Option-B re-run can never
  corrupt; it just does nothing for dormant rows (the §2.2 trap). Safety and "did it heal" are
  different questions — verify heal with §7, do not infer it from a clean run.
- **S3 captures are never mutated** — re-parse is GET-only against the gateway bucket;
  `agent_raw_captures` rows are untouched (Option A's DELETE uses `SetNull` on `lastCaptureId`,
  not cascade, so captures survive — `schema.prisma:1141`).
- **Known minor quirk (not a blocker):** the enqueued job payload is
  `{ hostId, sourcePathHash, sourceApp }` with **no `userId`** (`reparse-chats.ts:421-425`),
  while `AgentParseJobData` declares `userId` (`agent-gateway.types.ts:144-156`). The worker
  only uses `userId` to set Sentry user scope (`agent-parse.processor.ts:63`); the actual work
  fetches by host/path/app. So re-parse ticks lose Sentry user attribution but parse correctly.
  Pre-existing behavior — note it; do not "fix" it inside Phase 11.

---

## 7. Verification — the spot-check that actually proves the heal (NOT "the queue drained")

Per §2.2 the queue draining proves nothing. Run **before/after** read-only token comparisons
(operator-run, read-only `POSTGRES_URL_READ_ONLY_PROD`). The spec's "Orchestrator quick-check"
requires exactly these:

1. **CODEX over-count dropped** — pick a known multi-turn Codex chat from the dry-run sample;
   capture its `SUM(input_tokens)` / `SUM(cache_read_input_tokens)` before, re-run after.
   Expect the stored input to **drop** (the re-emit over-count removed). **If it is UNCHANGED,
   the shrink-guard vetoed the heal** (dormant row) → that row needs Option A/C, not naive
   reparse. This is the canary for the whole §2.2 trap.
2. **gemini `cacheCreationInputTokens` is null** — pick a healed gemini row; expect
   `cache_creation_input_tokens IS NULL` after (phantom removed, Phase 3).
3. **CLAUDE_DESKTOP now has ACRs** — `SELECT COUNT(*) FROM agent_call_records WHERE agent =
   'CLAUDE_DESKTOP'` goes from **0** to non-zero (Phase 7 populate). This one should always work
   (fresh INSERT).
4. **CLAUDE_CODE idle turns recovered** — for a chat that idle-flushed mid-tool-loop, the
   post-flush continuation tokens are now included (Phase 5). **Set the expectation that F1
   dialogue-filter history stays low** — those bytes never reached S3.

Cross-check that no aggregate double-counts `cacheCreationInputTokens` (it is a non-additive
subset of `inputTokens`) — already confirmed in `VERIFICATION_FINDINGS.md` §9 (the 7
org-analytics services + `/agent-call-record-stats` sum disjoint `COALESCE(SUM,0)`); the
re-parse does not change that contract.

---

## 8. Hand-back report (send this to the orchestrator/verifier)

1. **Source change**: the `reparse-chats-args.ts` + `reparse-chats.ts` `--limit` diff, verbatim,
   plus the green output of `bun run typecheck` and
   `bun run test:unit scripts/seed-lib/_tests/reparse-chats-args.spec.ts`.
2. **Heal-strategy decision (§3)**: which option the operator approved per agent, and — if
   Option A — explicit acknowledgement of the `breadcrumb_records` cascade + stat-rebuild cost.
3. **Per-agent dry-run `matches=` counts** (the change-count report) with the prod-row sanity
   cross-check.
4. **Stale-spec flag**: state that the Phase 11 spec's / ROADMAP §11.1's "UPSERT REPLACEs each
   row idempotently" is accurate ONLY for strictly-larger-watermark rows; dormant equal-watermark
   rows are vetoed by the Phase-4 shrink-guard (`parse-batch-upsert.service.ts:540-545`) and
   need Option A/C. This is the load-bearing correction.
5. **Post-run spot-check results (§7)** confirming Codex lower / gemini cacheCreation null /
   Desktop populated / CC idle recovered — and the explicit statement that **F1 CC history is
   permanently uncorrectable**, communicated to stakeholders.
6. **Anything you could not do without an `any`/suppression** — name the type friction instead
   of working around it.

---

## 9. Acceptance criteria (the verifier checks all)

- [ ] Phases **2, 3, 5, 7** are merged + DEPLOYED to the target env before any re-parse (and 4/6
      if landed). Confirmed via deployed `parser_version`.
- [ ] `--limit=N` batching flag added to `reparse-chats-args.ts` + `reparse-chats.ts` with unit
      specs; `typecheck` + the arg spec pass. No `any`, no suppression, no before/after refs.
- [ ] Dry-run produces a sane per-agent change-count report (Desktop, Codex, gemini, CC).
- [ ] Heal strategy (§3) explicitly chosen by the operator; if Option A, the `breadcrumb_records`
      cascade is acknowledged and a rebuild plan exists.
- [ ] Live re-parse run completed **by the operator** (NOT the agent), batched + throttled.
- [ ] Spot-check (§7) shows corrected tokens **that actually landed** (Codex input lower, gemini
      cacheCreation null, Desktop ACRs populated, CC idle turns recovered) — not merely "the
      queue drained."
- [ ] **F1 permanent-gap caveat communicated to stakeholders** before the run.

---

## 10. Out of scope (do NOT do these)

- **Do NOT re-parse CURSOR** — Phase 8 is DEFERRED (ROADMAP "Decisions LOCKED" item 3); Cursor
  stays all-null. Its non-semver `parser_version` never matches the semver filter anyway
  (`compileFilter` defensively returns false — `reparse-chats-args.ts:300-304`).
- **Do NOT write raw DML into any committed script** — the Option-A `DELETE` is operator-only,
  run outside the agent session. The agent's only source change is the `--limit` flag.
- **Do NOT run any prod-mutating command as the agent** — no `--execute`, no `DELETE`, no BullMQ
  enqueue against prod. Prepare + dry-run only; the operator runs the writes
  (`ai/rules/process/destructive-commands.md`; `reparse-chats.ts:32-39`).
- **Do NOT bump any schema/migration or change parser logic** — that work is Phases 2/3/5/7.
  Phase 11 only re-feeds existing captures through the deployed code.
- **Do NOT touch `isDialogueRecord` / the gateway** — F1 is a gateway-side, pre-S3 loss; no
  backend re-parse recovers it. Phase 11 is `proxai_nest`-only.
- **Do NOT trust "the queue drained" as proof of correction** — verify via §7 (the shrink-guard
  silently vetoes dormant-row heals).

---

## 11. Dependencies & sequencing (quick reference)

- **Depends on (must be DEPLOYED first):** Phase 2 (Codex), Phase 3 (Gemini), Phase 5 (CC
  idle-flush), Phase 7 (Claude Desktop version resolution). Benefits from Phase 4 (the
  shrink-guard) and Phase 6 (Codex re-attach).
- **Blocks:** nothing — Phase 11 is the terminal historical-data refresh; forward correctness is
  already handled by Phases 1–8.
- **Branch model:** stacked integration branch off `main`; nothing merges to prod until all
  active phases are complete + verified, and Phase 11's backfill runs against prod only AFTER
  the big merge (ROADMAP "Merge model" + "Decisions LOCKED" item 4).
