# Phase 9 — Implementation Instructions (for the implementer model)

> **Audience:** the small/fast implementer model that will write the code.
> **Author:** orchestrator chat (source-verified against `proxai_nest` on 2026-06-17).
> **Companion specs (already settled — do not re-open):**
> `../phase-09-deterministic-id-hardening.md`, `../ROADMAP.md`,
> `../analysis/VERIFICATION_FINDINGS.md` §11.5, `../analysis/IMPLEMENTATION_PLAN.md` Rank 9.
>
> Everything you need is here. Every path/line/snippet below was read from the actual
> source. **Follow it literally.** If line numbers have drifted, trust the *named symbol*
> (function/variable name), not the line number, and apply the same change at the symbol.
>
> **This phase is `proxai_nest` ONLY.** No gateway change. No schema/migration change.
> Severity 🟢 LOW (latent — moot on Node 24, which exposes `blake2b512`). Keep the change
> **precise and minimal.**

---

## 0. TL;DR — what you are doing

`deterministicRecordId` (the function that mints every agent-call-record primary key) silently
falls back from `blake2b512` to `sha256` truncation when the runtime doesn't expose
`blake2b512` (very old Node builds, OpenSSL FIPS configs). The two algorithms produce
**different ids for the same `(agent, chatId, turnId)` triple**, so a fleet that straddles the
boundary would re-key a turn to a NET-NEW primary key instead of upserting → double-counted
usage at the `(user, chat)` rollup. Today the only signal is a `console.warn`, which is invisible
to the alert pipeline.

You will make the fallback **loud**: replace the `console.warn` with a Grafana-visible counter
(`Logger.metric`, which bypasses `LOG_LEVEL`) **plus** a `Sentry.captureMessage` so the condition
pages instead of hiding in stdout. The detection is already memoized, so the alarm fires at most
once per process — no hot-loop concern.

**Files you will touch (all in `proxai_nest`):**
1. `src/agent-gateway/parsers/parsers.utils.ts` — replace the silent `console.warn` with metric + Sentry; add two imports; refresh two docstrings. (the core change)
2. `src/telemetry/metric-kind-registry.ts` — register the new counter (mandatory — an unregistered metric is silently dropped from OTLP/Grafana, and a CI test fails).
3. `src/agent-gateway/parsers/tests/parsers.utils.spec.ts` — rewrite the existing fallback test to assert the loud behavior.

**Total surface:** 2 source files + 1 test file. No new module, no queue, no env-var, no schema.

---

## 1. Hard rules (non-negotiable — enforced by lint/CI/reviewers)

- **No `any`** — not `: any`, `as any`, `Promise<any>`, `Record<string, any>`, generic default
  `= any`, or implicit any, in source **or** `.spec.ts`. Use `unknown` + a type guard at
  boundaries. If a 3rd-party type *forces* an any, **stop and report it** — don't insert one.
- **No suppression comments** — `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`,
  `eslint-disable`, `oxlint-disable`, `v8 ignore`. Fix the type instead.
- **No "before/after" references** in code/comments/test names. Describe **current** behavior
  only. The new test name says what the code does now (e.g.
  `it('emits a metric and Sentry alarm when blake2b512 is unavailable', …)`), never "no longer
  warns" / "used to console.warn".
- **Comments explain *why***, not *what*. No banners. No restating the code.
- **No hardcoded enum-string values** — not relevant here (no Prisma enums touched), but the
  metric name is a literal string used in exactly two places (the emit site + the registry);
  that is the convention for metric names.
- **Package manager: `bun`.** Tests: `bun run test:unit <path>` (never raw `vitest`). Typecheck:
  `bun run typecheck`. Do **not** run `bun run validate` while iterating.
- **Git:** do **not** commit/push/branch/stage unless the operator tells you to. Leave edits in
  the working tree.

---

## 2. The mental model — READ THIS BEFORE WRITING CODE

### 2.1 What the function does today (verified `parsers.utils.ts:29-58`)

```ts
let blake2bAvailable: boolean | null = null;

function isBlake2bAvailable(): boolean {
  if (blake2bAvailable !== null) return blake2bAvailable;
  try {
    createHash('blake2b512');
    blake2bAvailable = true;
  } catch {
    blake2bAvailable = false;

    console.warn(
      '[parsers] blake2b512 unavailable; falling back to sha256 truncation. ' +
        'Re-parse compatibility may break across this boundary.',
    );
  }
  return blake2bAvailable;
}

export function deterministicRecordId(
  agent: AgentAppName,
  chatId: string,
  turnId: string,
): string {
  const algo = isBlake2bAvailable() ? 'blake2b512' : 'sha256';
  const hex = createHash(algo)
    .update(`${agent}|${chatId}|${turnId}`)
    .digest('hex');
  // 32 hex chars = 16 bytes = 128 bits.
  return hex.slice(0, 32);
}
```

Three load-bearing facts:

1. **The probe is memoized.** `blake2bAvailable` is a module-level `boolean | null`. The `try/catch`
   (and therefore the warn, and therefore your new alarm) runs **once per process**, the first
   time any caller mints an id. This is why emitting `Logger.metric` + `Sentry.captureMessage`
   here is safe and does **not** violate the hot-loop emit rule — it cannot fire per-record.
2. **The fallback still returns a valid, self-deterministic id.** sha256-truncated to 32 hex chars.
   The bug is not that ids break within one runtime — it's that they **differ across the
   blake2b↔sha256 boundary**, so the same turn upserted by a blake2b worker and re-parsed by a
   sha256 worker becomes two PKs. You do **not** change the digest/return logic — only the alarm.
3. **`agent` is typed `AgentAppName`** (`'CLAUDE_CODE' | 'CLAUDE_DESKTOP' | 'CURSOR' | 'CODEX' |
   'gemini'`, verified `src/agent-gateway/agent-gateway.types.ts:41-48`). The compiler already
   prevents an empty/missing `agent`. `chatId`/`turnId` are plain strings — see §9 for why their
   emptiness is **out of scope** for this phase.

### 2.2 Who calls it (verified — for your situational awareness; you change NONE of these)

`deterministicRecordId` is the single id-minting helper for all parsers. Call sites:

| Caller | Args passed |
|---|---|
| `claude-code/services/claude-code-finalize-turn.service.ts:300` | `deterministicRecordId(chat.agent, chat.chatId, promptId)` |
| `gemini/services/gemini-finalize-turn.service.ts:194` | `deterministicRecordId('gemini', chat.chatId, turnId)` |
| `cursor/services/cursor-finalize-turn.service.ts:326` | `deterministicRecordId('CURSOR', chat.chatId, turnId)` |
| `cursor/services/cursor-agent-kv-turn.service.ts:183` | `deterministicRecordId('CURSOR', chat.chatId, turnId)` |
| `codex/services/codex-finalize-turn.service.ts:265` | `deterministicRecordId('CODEX', chat.chatId, turnId)` |
| `agents/ui/project-tracker/services/project-tracker-record-detail.service.ts:81` | `deterministicRecordId(record.agent as unknown as AgentAppName, record.chatId, record.parentTurnId)` (UI read — recompute parent ACR id) |

You touch **none** of these. The fix is entirely inside `parsers.utils.ts`'s `isBlake2bAvailable`.

### 2.3 The fix in one sentence

Replace the single `console.warn` in the `catch` block with `Logger.metric(<counter>, 1, {})` +
`Sentry.captureMessage(<static message>, { level, fingerprint, extra })`, register the counter,
and update the test. That's the whole job.

---

## DECISION (flagged for the reviewer): metric + Sentry, NOT boot-refusal

The phase spec offers two equally-acceptable shapes: **(A)** boot-time refusal with an override
env-var, or **(B)** `Logger.metric` + Sentry tag. **This plan implements (B).** Rationale,
stated explicitly so the reviewer can overrule with one instruction:

- **Lowest blast radius.** (B) is a single `catch`-block edit + one registry line + a test rewrite,
  entirely inside the existing memoized probe. (A) requires *either* throwing inside a pure
  hashing util (which would crash-loop every parse job and break every test fixture that mints an
  id on a sha256 box) *or* adding a brand-new NestJS boot hook that imports the parser util and
  reads an override env-var — strictly more surface and a new coupling, for a 🟢-LOW latent bug
  that is **moot on Node 24**.
- **Cannot brick a deploy.** (B) keeps a legitimately FIPS-constrained, *all-sha256* deploy
  running (its ids are internally self-consistent), while still alarming. (A)'s boot-refusal must
  carry an override specifically so it doesn't brick that deploy (the spec's own "Risk" note) —
  more moving parts to get a worse failure mode wrong.
- **`parsers.utils.ts` is a shared, DI-free util** imported by four finalize-turn services, a UI
  read service, and test fixtures. Keeping the change to an observability side-effect (which the
  file already has, as `console.warn`) preserves that property; a throw would not.
- **No silent path remains** — which is the actual acceptance criterion. `Logger.metric` reaches
  Grafana (bypasses `LOG_LEVEL`) and is alertable; `Sentry.captureMessage` pages. Both are louder
  than the `console.warn` they replace.

**If the reviewer instead wants boot-refusal**, the override env-var would be
`ALLOW_NON_BLAKE2B_RECORD_ID` checked as `process.env.ALLOW_NON_BLAKE2B_RECORD_ID === 'true'`
(the repo's boolean-env idiom — verified `src/otel-init.ts:44`, `src/ingestion/ingestion.controller.ts:110`),
the refusal would throw from `AgentGatewayModule`'s existing `onModuleInit`
(`src/agent-gateway/agent-gateway.module.ts:179,200`) by calling a new exported
`assertRecordIdHashingAvailable()` probe, and §3/§7 would change accordingly. **Do not build
both.** Build (B) unless told otherwise.

---

## 3. CHANGE 1 — `parsers.utils.ts` (make the fallback loud)

**File:** `src/agent-gateway/parsers/parsers.utils.ts`

### 3.1 Add the two imports

Find the current import block at the top of the file:

```ts
import { createHash } from 'node:crypto';

import type { AgentAppName } from '../agent-gateway.types';
```

Replace it with (adds `@sentry/nestjs` in the third-party group and `Logger` in the local group —
matches the ordering used at `src/agent-gateway/parse/services/parse-idle-flush.service.ts:37-48`):

```ts
import { createHash } from 'node:crypto';

import * as Sentry from '@sentry/nestjs';

import { Logger } from '../../common/utils';
import type { AgentAppName } from '../agent-gateway.types';
```

> Path check: `parsers.utils.ts` is at `src/agent-gateway/parsers/`, so `../../common/utils`
> resolves to `src/common/utils` (the barrel that re-exports `Logger` from `logging.util` —
> verified `src/common/utils/index.ts:3`). `@sentry/nestjs` is the package every agent-gateway
> service uses (verified `parse/services/*.ts`). Both are already loaded at boot via
> `src/instrument.ts`; importing them here is free and safe to call from tests (Sentry is a
> no-op when uninitialized — disabled under Vitest, verified `src/instrument.ts:99-102`).

### 3.2 Replace the `console.warn` with the metric + Sentry alarm

Find the `isBlake2bAvailable` function (verified `parsers.utils.ts:29-45`):

```ts
let blake2bAvailable: boolean | null = null;

function isBlake2bAvailable(): boolean {
  if (blake2bAvailable !== null) return blake2bAvailable;
  try {
    createHash('blake2b512');
    blake2bAvailable = true;
  } catch {
    blake2bAvailable = false;

    console.warn(
      '[parsers] blake2b512 unavailable; falling back to sha256 truncation. ' +
        'Re-parse compatibility may break across this boundary.',
    );
  }
  return blake2bAvailable;
}
```

Replace it with:

```ts
let blake2bAvailable: boolean | null = null;

function isBlake2bAvailable(): boolean {
  if (blake2bAvailable !== null) return blake2bAvailable;
  try {
    createHash('blake2b512');
    blake2bAvailable = true;
  } catch {
    blake2bAvailable = false;
    // A runtime without blake2b512 mints record ids via sha256 truncation, which
    // differ from blake2b ids for the same (agent, chatId, turnId). In a fleet where
    // some replicas expose blake2b and some don't, the same turn re-keys to a NEW
    // primary key instead of upserting — double-counting usage at the (user, chat)
    // rollup. The probe is memoized, so this fires at most once per process: a
    // Grafana-visible counter (bypasses LOG_LEVEL) plus a Sentry capture so the
    // condition pages instead of hiding in stdout.
    Logger.metric(
      'agent_gateway_parser_record_id_hash_downgraded_total',
      1,
      {},
    );
    Sentry.captureMessage(
      'deterministicRecordId: blake2b512 unavailable; record ids minted via sha256 ' +
        'truncation — id identity diverges from blake2b across the fallback boundary',
      {
        level: 'error',
        fingerprint: ['parsers-blake2b-unavailable'],
        extra: { algorithm: 'sha256' },
      },
    );
  }
  return blake2bAvailable;
}
```

What changed and why each piece is shaped this way:

- **`Logger.metric(...)`** — the alertable, Grafana-visible signal. Metrics bypass `LOG_LEVEL`
  (verified `ai/rules/observability/logger-import.md`), so the alarm survives even when ops mute
  verbose logs. Value `1`, no tags (`{}`) — the metric's *existence* (any sample > 0) is the entire
  signal; there is no bounded dimension worth adding. **It is a `counter`** (monotonic, `_total`
  suffix) → register it in §4.
- **`Sentry.captureMessage(...)`** — the paging signal. A **static message + explicit
  `fingerprint`** so a multi-worker downgrade collapses into ONE Sentry issue rather than one per
  worker (this is exactly the pattern at
  `src/agent-gateway/parse/services/agent-parse-failed-stalled.event-listener.ts:63-70`).
  `level: 'error'` because this is a data-correctness hazard, not a benign degradation. The
  `extra` carries the chosen algorithm for forensics.
- **`console.warn` is removed.** The orchestrator quick-check greps to confirm the warn was
  replaced with a loud path; the two loud channels above are that path.

### 3.3 Refresh the two stale docstrings (describe current behavior)

**(a)** The module docstring at the top of the file currently reads (verified `parsers.utils.ts:1-8`):

```ts
/**
 * Shared parser utilities. Per-agent specifics live in `<agent>/<agent>.utils.ts`
 * (Claude Code's JSONL classifier, Cursor's lexical-format JSON walker, Codex's
 * thread-uuid joiner). Cross-agent helpers live here.
 *
 * No NestJS imports; pure functions only — safe to call from any service or
 * test fixture.
 */
```

Replace the second paragraph so it stays accurate now that the file emits an observability signal:

```ts
/**
 * Shared parser utilities. Per-agent specifics live in `<agent>/<agent>.utils.ts`
 * (Claude Code's JSONL classifier, Cursor's lexical-format JSON walker, Codex's
 * thread-uuid joiner). Cross-agent helpers live here.
 *
 * These helpers use no NestJS dependency injection — they are importable from any
 * service or test fixture. The one side effect is the memoized blake2b availability
 * probe, which emits a metric + Sentry alarm (once per process) when the runtime
 * forces the sha256 record-id fallback.
 */
```

**(b)** The `deterministicRecordId` docstring currently ends (verified `parsers.utils.ts:23-28`):

```ts
 * Falls back to sha256 truncation when the Node runtime doesn't expose
 * `blake2b512` (very old builds; OpenSSL FIPS configs). The fallback is
 * deterministic in itself but produces DIFFERENT ids than blake2b — re-parse
 * compatibility breaks across the fallback boundary. We log a warning so the
 * operator notices.
 */
```

Replace the final sentence to describe the loud alarm:

```ts
 * Falls back to sha256 truncation when the Node runtime doesn't expose
 * `blake2b512` (very old builds; OpenSSL FIPS configs). The fallback is
 * deterministic in itself but produces DIFFERENT ids than blake2b — re-parse
 * compatibility breaks across the fallback boundary. The downgrade is alarmed
 * loudly — a Grafana counter (`agent_gateway_parser_record_id_hash_downgraded_total`)
 * plus a Sentry capture — because it is a silent duplicate-row source, not a
 * benign degradation.
 */
```

### 3.4 What you must NOT change in this file

- **The digest / return logic** (`const algo = … ? 'blake2b512' : 'sha256'`, the
  `createHash(algo).update(...).digest('hex')`, the `hex.slice(0, 32)`). The fallback must still
  return a valid id; you are only changing the *alarm*.
- **The function signature** of `deterministicRecordId`. No new params, no env-var read, no throw.
- **`textContent` / `thinkingContent`** — untouched.

---

## 4. CHANGE 2 — register the metric (MANDATORY)

**File:** `src/telemetry/metric-kind-registry.ts`

An unregistered metric name is **silently dropped** from the OTLP/Grafana pipeline (verified
mechanism: `src/otel-init.ts` `recordMetric` returns early when `METRIC_KIND_REGISTRY[name]` is
absent; rule `ai/rules/observability/metric-kind-registry.md`). It also fails a CI test (see §5.3).

Add the entry to the `// --- agent_gateway ---` block, **alphabetically** between
`agent_gateway_parser_provider_inferred_total` and
`agent_gateway_parser_replay_filtered_other_composer_total` (verified
`metric-kind-registry.ts:161-162`):

```ts
    agent_gateway_parser_provider_inferred_total: 'counter',
    agent_gateway_parser_record_id_hash_downgraded_total: 'counter',
    agent_gateway_parser_replay_filtered_other_composer_total: 'counter',
```

`counter` is correct: it increments by `1` on the one-time downgrade detection (monotonic, the
`_total` suffix matches the counter convention). No `KNOWN_EXCEPTIONS` pin is needed — the suffix
and the kind agree.

> Do **not** add any label to `METRIC_LABEL_DENYLIST` — the metric carries no high-cardinality
> tags (it emits `{}`).

---

## 5. CHANGE 3 — Tests

Runner: `bun run test:unit <path>` (Vitest). The spec lives at
`src/agent-gateway/parsers/tests/parsers.utils.spec.ts`.

### 5.1 Update `afterEach` to unmock the two new mocked modules

The existing `afterEach` (verified `parsers.utils.spec.ts:4-8`) unmocks only `node:crypto`. Your
new test mocks the `Logger` barrel and `@sentry/nestjs` as well, so unmock them too:

```ts
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('node:crypto');
    vi.doUnmock('../../../common/utils');
    vi.doUnmock('@sentry/nestjs');
    vi.resetModules();
  });
```

### 5.2 Rewrite the fallback test

The existing test (verified `parsers.utils.spec.ts:26-48`) asserts the old `console.warn`:

```ts
  it('falls back to sha256 when blake2b is unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fallbackHex = '0123456789abcdef0123456789abcdefcafebabe';
    vi.doMock('node:crypto', () => ({
      createHash: (algorithm: string) => {
        if (algorithm === 'blake2b512') {
          throw new Error('unsupported algorithm');
        }
        expect(algorithm).toBe('sha256');
        const hash = {
          update: (_input: string) => hash,
          digest: (_encoding: string) => fallbackHex,
        };
        return hash;
      },
    }));
    const { deterministicRecordId } = await import('../parsers.utils');

    expect(deterministicRecordId('CODEX', 'chat-1', 'turn-1')).toBe(
      fallbackHex.slice(0, 32),
    );
    expect(warn).toHaveBeenCalledTimes(1);
  });
```

**Replace it entirely** with the loud-path test below. It mocks the `Logger` barrel and
`@sentry/nestjs` via `vi.doMock` (the non-hoisted variant, so the factories can close over the
test-scope `vi.fn()`s — the same closure pattern the existing `node:crypto` mock already relies on
with `fallbackHex`). Both `vi.doMock` specifiers resolve, from the test's location
(`parsers/tests/`), to the exact module ids that `parsers.utils.ts` imports — `'../../../common/utils'`
→ `src/common/utils`, and `'@sentry/nestjs'` — so Vitest intercepts both:

```ts
  it('emits a metric and Sentry alarm and still returns an id when blake2b512 is unavailable', async () => {
    const metric = vi.fn();
    const captureMessage = vi.fn();
    const fallbackHex = '0123456789abcdef0123456789abcdefcafebabe';
    vi.doMock('node:crypto', () => ({
      createHash: (algorithm: string) => {
        if (algorithm === 'blake2b512') {
          throw new Error('unsupported algorithm');
        }
        expect(algorithm).toBe('sha256');
        const hash = {
          update: (_input: string) => hash,
          digest: (_encoding: string) => fallbackHex,
        };
        return hash;
      },
    }));
    vi.doMock('../../../common/utils', () => ({ Logger: { metric } }));
    vi.doMock('@sentry/nestjs', () => ({ captureMessage }));
    const { deterministicRecordId } = await import('../parsers.utils');

    // The fallback still mints a valid, self-deterministic id.
    expect(deterministicRecordId('CODEX', 'chat-1', 'turn-1')).toBe(
      fallbackHex.slice(0, 32),
    );

    // The downgrade is loud, not silent.
    expect(metric).toHaveBeenCalledWith(
      'agent_gateway_parser_record_id_hash_downgraded_total',
      1,
      {},
    );
    expect(captureMessage).toHaveBeenCalledTimes(1);
  });

  it('alarms at most once per process even across repeated calls', async () => {
    const metric = vi.fn();
    const captureMessage = vi.fn();
    const fallbackHex = '0123456789abcdef0123456789abcdefcafebabe';
    vi.doMock('node:crypto', () => ({
      createHash: (algorithm: string) => {
        if (algorithm === 'blake2b512') {
          throw new Error('unsupported algorithm');
        }
        const hash = {
          update: (_input: string) => hash,
          digest: (_encoding: string) => fallbackHex,
        };
        return hash;
      },
    }));
    vi.doMock('../../../common/utils', () => ({ Logger: { metric } }));
    vi.doMock('@sentry/nestjs', () => ({ captureMessage }));
    const { deterministicRecordId } = await import('../parsers.utils');

    deterministicRecordId('CODEX', 'chat-1', 'turn-1');
    deterministicRecordId('CODEX', 'chat-1', 'turn-2');
    deterministicRecordId('CLAUDE_CODE', 'chat-9', 'turn-9');

    // Memoized probe → the alarm fires exactly once regardless of call volume.
    expect(metric).toHaveBeenCalledTimes(1);
    expect(captureMessage).toHaveBeenCalledTimes(1);
  });
```

### 5.3 Leave the other tests in this file UNCHANGED, and run the registry guard

- `it('creates stable deterministic record ids', …)` (`parsers.utils.spec.ts:10-24`) uses **real**
  `crypto` → `blake2b512` is present → no alarm fires → `Logger`/`Sentry` are never called. It
  stays green as-is. Same for the `textContent` / `thinkingContent` tests.
- A **separate existing CI test** scans every non-test `src/**/*.ts` for `Logger.metric('<name>')`
  call sites and asserts each name is in `METRIC_KIND_REGISTRY` (verified
  `src/telemetry/tests/metric-kind-registry.spec.ts:10-40`, regex
  `/(?:Logger|LoggingUtil)\.metric\(\s*['"]([a-zA-Z0-9_]+)['"]/g`). Your new emit site is a literal
  string, so this test **will fail if you skip §4** — run it (command in §6) to prove the
  registration landed.

---

## 6. Execution order & commands

1. Edit `src/agent-gateway/parsers/parsers.utils.ts` (§3 — imports, the `catch` block, two docstrings).
2. Edit `src/telemetry/metric-kind-registry.ts` (§4 — register the counter).
3. Edit `src/agent-gateway/parsers/tests/parsers.utils.spec.ts` (§5 — `afterEach` + rewrite + the once-per-process test).
4. Run:
   ```bash
   bun run typecheck
   bun run test:unit src/agent-gateway/parsers/tests/parsers.utils.spec.ts
   bun run test:unit src/telemetry/tests/metric-kind-registry.spec.ts
   ```
   Do NOT run `bun run validate` while iterating.

If a command fails, fix the cause — never silence it with a suppression or an `any`.

---

## 7. Audit / self-check before hand-back

Run these from the `proxai_nest` root:

- `grep -n "blake2b\|sha256\|console.warn\|Logger\|Sentry" src/agent-gateway/parsers/parsers.utils.ts`
  → confirms the `console.warn` is gone and the `Logger.metric` + `Sentry.captureMessage` loud path
  is present (this is the orchestrator's exact quick-check from the phase spec).
- `grep -rn "console.warn" src/agent-gateway/parsers/parsers.utils.ts` → returns **nothing**
  (no silent path remains).
- `grep -n "agent_gateway_parser_record_id_hash_downgraded_total" src/telemetry/metric-kind-registry.ts`
  → returns exactly **one** line (the registration), classified `'counter'`.
- Confirm `deterministicRecordId`'s **signature is unchanged** (`(agent, chatId, turnId) => string`)
  and the digest/`slice(0, 32)` logic is byte-for-byte the same — you only changed the alarm.
- Confirm you did **not** touch any of the six call sites in §2.2, any other parser, any schema,
  any queue, or `build-scalar-spine.ts`.

---

## 8. Hand-back report (send this back to the orchestrator/verifier)

1. **Files changed** (path + one line each) — should be exactly the three in §0.
2. **The diff** for `parsers.utils.ts` (imports + `catch` block + the two docstrings) and the
   one-line registry addition, pasted verbatim.
3. **Test results**: paste the green output of both `bun run test:unit` commands in §6 and of
   `bun run typecheck`.
4. **Confirm the flagged decision** was implemented as written: **metric + Sentry (option B)**, NOT
   boot-refusal; no override env-var added. If the reviewer asked for boot-refusal instead, say so
   and follow the §"DECISION" alternative spec.
5. **State the audit-grep results** from §7 (warn removed; metric registered; signature unchanged).
6. **Anything you could not do without an `any`/suppression** — name the type friction instead of
   working around it. (None is expected; `vi.fn()` is fully typed and the mock factories return
   plain objects.)
7. **Optional note** (do not act on it): the delimiter-collision edge in §9 is real but out of
   scope; flag it only if the reviewer wants a follow-up phase.

---

## 9. Out of scope (do NOT do these)

- **Empty / delimiter-injection id components.** The orchestrator's orientation mentioned a
  collision concern when an id component (`chatId`/`turnId`) is empty or contains the `|`
  separator (e.g. `chatId='a|b', turnId='c'` and `chatId='a', turnId='b|c'` both join to
  `agent|a|b|c`). This is a **real but separate, latent** concern that the **phase-09 spec does
  not cover** — its "Concern this phase eliminates", "Change spec", and acceptance criteria are all
  exclusively about the `blake2b512` → `sha256` fallback. `agent` is type-constrained
  (`AgentAppName`); `chatId`/`turnId` come from parsed capture ids (session/prompt/turn uuids) that
  do not contain `|` in practice. **Do not add length-prefix / escaping / empty-guards** — that
  would change the id derivation for every existing record (a PK-rewrite, the opposite of this
  phase's forward-protective intent). Note it in the hand-back if you like; do not implement it.
- **Boot-time refusal + override env-var.** Considered and rejected for this phase (see the DECISION
  block). Do not add `ALLOW_NON_BLAKE2B_RECORD_ID` or any boot hook unless the reviewer instructs.
- **Changing the digest, the truncation length, or the `blake2b512`/`sha256` choice.** The fallback
  must keep producing the same id it does today; only the alarm changes.
- **Touching any parser, finalize-turn service, the UI record-detail service, the batch upsert, or
  the shared `build-scalar-spine.ts`.** Phase 9 is confined to `parsers.utils.ts` + the metric
  registry + the one test file.
- **Historical correction / re-parse.** That is Phase 11. This phase is forward-protective only —
  it guards against a future runtime regression; it does not fix any existing data (there is no
  affected data on Node 24).

---

## 10. Acceptance criteria (the verifier checks all)

- [ ] The `blake2b512`-unavailable fallback is **loud**: `Logger.metric('agent_gateway_parser_record_id_hash_downgraded_total', 1, {})` **and** `Sentry.captureMessage(...)` fire on the downgrade; the `console.warn` is gone; **no silent path remains**.
- [ ] The alarm fires **at most once per process** (memoized probe) — proven by the §5.2 once-per-process test.
- [ ] The fallback still returns a valid, self-deterministic 32-hex-char id; `deterministicRecordId`'s signature and digest logic are unchanged.
- [ ] `agent_gateway_parser_record_id_hash_downgraded_total` is registered as a `counter` in `METRIC_KIND_REGISTRY`; the registry completeness test (`src/telemetry/tests/metric-kind-registry.spec.ts`) passes.
- [ ] The rewritten + new `parsers.utils.spec.ts` tests are green; `bun run typecheck` passes.
- [ ] No `any`, no suppression comments, no before/after references; no env-var / boot-refusal added (option B as flagged); no other file touched.
