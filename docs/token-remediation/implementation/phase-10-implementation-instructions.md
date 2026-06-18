# Phase 10 — Implementation Instructions (for the implementer model)

> **Audience:** the small/fast implementer model that will write the code.
> **Author:** orchestrator chat (source-verified against `proxai_web` + `proxai_nest` on 2026-06-17).
> **Companion specs (already settled — do not re-open):**
> `../phase-10-web-kpi-label-cursor-display.md`, `../ROADMAP.md`
> ("Column normalization" + "Token semantics — SETTLED"),
> `../analysis/CROSS-SOURCE-NORMALIZATION.md`.
>
> Everything you need is here. Every path/line/snippet below was read from the
> actual source. **Follow it literally.** If line numbers have drifted, trust the
> *named symbol* (component / function / interface name), not the line number.
>
> **This phase is `proxai_web` ONLY.** No `proxai_nest` change. No `proxai_gateway`
> change. No schema/migration change. No wire-contract change. Display-only.

---

## 0. TL;DR — what you are doing

Two small, display-only fixes in the **agent analytics** dashboard, plus tests:

1. **KPI label** — the "Token Usage" headline KPI value is a **three-column**
   sum `input + output + cache-read`, but its subtitle reads "Input + output
   tokens". For Gemini, cache-read is a large fraction of the prompt, so the
   label materially understates what the number means. Fix: change the subtitle
   string to name the cache-read inclusion.
2. **Cursor "not captured" display** — Cursor token collection is **deferred
   (Phase 8)**, so Cursor's per-turn token columns are `NULL` in the database.
   The backend `COALESCE(SUM(...), 0)`s them to **`0`** on the wire, so the
   per-agent breakdown table shows Cursor with `0` input / `0` output / `0`
   cache — indistinguishable from a real agent that genuinely used zero tokens.
   Fix: render Cursor's four token cells as **"not captured"** instead of `0`.

**Files you will touch (all in `proxai_web`):**

| # | File | Change |
|---|---|---|
| 1 | `app/dashboard/organization/(workspace)/analytics/acr/_components/agent-metrics-dashboard.tsx` | One subtitle string. |
| 2 | `app/dashboard/organization/(workspace)/analytics/acr/_components/acr-stats-org-source-table.tsx` | Agent-aware "not captured" for Cursor's token cells. |
| 3 | `app/dashboard/organization/(workspace)/analytics/acr/_components/_tests/agent-metrics-dashboard.test.tsx` | Add a subtitle test. |
| 4 | `app/dashboard/organization/(workspace)/analytics/acr/_components/_tests/acr-stats-org-source-table.test.tsx` | Add a Cursor + genuine-zero test. |

**Total surface:** 2 source files + 2 test files in one repo. No backend, no schema, no new component.

---

## 1. Hard rules (non-negotiable — enforced by lint/CI/reviewers)

- **No `any`** — not `: any`, `as any`, `Promise<any>`, `Record<string, any>`,
  generic default `= any`, or implicit any, in source **or** `.test.tsx`. Use
  `unknown` + a type guard at boundaries. A DOM narrowing via the generic
  `el.closest<HTMLElement>('tr')` or a `!` non-null assertion after an explicit
  null-check is **not** an `any` and is allowed. If a third-party type *forces*
  an any, **stop and report it** — don't insert one.
- **No suppression comments** — `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`,
  `eslint-disable`, `oxlint-disable`, `v8 ignore`. Fix the type instead.
- **No "before/after" references** in code, comments, or test names. Describe
  **current** behavior only. A test name says what the UI does now
  (`it('renders "not captured" for Cursor token cells', …)`), never "used to show 0".
- **Comments explain *why***, not *what*. No decorative banners.
- **No hardcoded enum-string values.** The Cursor check must reference the
  wire-contract agent kind through a typed constant (see §3.2), not a bare loose
  `'CURSOR'` literal scattered at the comparison site.
- **Package manager: `bun`.** Test runner for `proxai_web` is **Vitest**
  (`bun run test:unit` does NOT exist in this repo — the script is named `test`;
  run a single file with `bun run test <path>`; see §5). Typecheck: `bun run typecheck`.
  Do **not** run `bun run validate` while iterating.
- **Git:** do **not** commit/push/branch/stage unless the operator tells you to.
  Leave edits in the working tree.

---

## 2. The mental model — READ THIS BEFORE WRITING CODE

### 2.1 Where the KPI value comes from (so you know the label must change)

The agent dashboard's two KPI cards are defined in a **local** `AGENT_METRICS`
array inside `agent-metrics-dashboard.tsx` (NOT the SDK `METRICS` array in
`../../sdk/_components/metric-defs.tsx` — that is a different dashboard, **out of
scope**; see §9). The "Token Usage" card's value is:

```ts
actual.totalTokenCount + cached.totalTokenCount
```

`actual` and `cached` are `AnalyticsStatsData` objects rolled up in
`agent-analytics-content.tsx::aggregateTotals` from the backend's
`data.providerStats[].providerStatsData` (actual) and `.cachedStatsData` (cached).
Trace those back to `proxai_nest`:

- **`providerStatsData.totalTokenCount`** is built in
  `proxai_nest/src/organizations/analytics/acr/utils/acr-stats-org-aggregation.utils.ts`
  (`counterFieldsFrom` line ~124 and `addToCounters` line ~106) as
  `totalInputTokens + totalOutputTokens` — i.e. **input + output**.
- **`cachedStatsData.totalTokenCount`** is built by `cachedCountersFrom`
  (`acr-stats-org-aggregation.utils.ts:66-84`) as `totals.cacheReadTokens ?? 0` —
  i.e. **cache-read**.

So the KPI value is **`(input + output) + cache-read`** — a three-column disjoint
sum. The current subtitle "Input + output tokens" names only two of the three.

**Worked example (real-shaped numbers).** An org whose agent stats are
`input = 300M`, `output = 50M`, `cache-read = 200M`, `cache-creation = 40M`
(`cache-creation` is a non-additive subset of input under the normalization scheme
— see ROADMAP "Column normalization" — and is **not** in this KPI):

```
KPI "Token Usage" value = (input + output) + cache-read
                        = (300M + 50M)    + 200M
                        = 550M
```

The old subtitle "Input + output tokens" implies **350M**, but the rendered
headline is **550M** — off by the 200M cache-read. For Gemini, cache-read is
~52% of the prompt, so the label is materially wrong. The new subtitle
**"Input + output + cache-read tokens"** matches the 550M the user sees.

> Note `cache-creation` (40M) is **correctly excluded** from this KPI today — it
> is already inside `inputTokens` under the normalization scheme, so adding it
> would double-count (the F3 shape). You will **not** add it. The audit in §6
> confirms no web total folds it in.

### 2.2 Why Cursor shows `0` and why that is a lie

Cursor token collection is **deferred** (ROADMAP Phase 8, `⏸️ DEFERRED`). The
Cursor parser stores `NULL` for every token column. The agent-stats SQL in
`proxai_nest/src/organizations/analytics/acr/services/acr-stats-org.service.ts:175-183`
sums them with `COALESCE(SUM(acr.input_tokens), 0)::bigint` (and likewise for
output / cache_read / cache_creation), so **NULL becomes `0` before it ever
reaches the wire**. The web wire type `AnalyticsStatsData`
(`services/organization/analytics-stats-data.types.ts:1-15`) types every token
field as `number` — it **never sees `null`**.

So in the per-agent breakdown table a Cursor row renders:

```
PROVIDER   RECORDS   TOOL CALLS   INPUT   OUTPUT   CACHE CREATE   CACHE READ   AVG DURATION
Cursor       120        300          0       0           0            0           1.2s
```

A reader cannot tell "Cursor ran 120 prompts and we did not capture tokens" from
"Cursor genuinely used zero tokens." The honest display is **"not captured"** on
the four token cells, leaving RECORDS / TOOL CALLS / AVG DURATION real:

```
PROVIDER   RECORDS   TOOL CALLS    INPUT          OUTPUT     CACHE CREATE     CACHE READ    AVG DURATION
Cursor       120        300      not captured   not captured  not captured   not captured     1.2s
```

### 2.3 The decision this forces — there is **no `null` to detect** client-side

> **DECISION (flagged for the reviewer) — detection is by AGENT IDENTITY, not by value.**
> The phase spec's Background says "Cursor's all-null token fields are coerced to
> 0 (`?? 0`)" and points at `acr-stats-org-source-table.tsx:101-112`. **That
> framing is stale and you must not follow it literally:** the web type is
> `number` (never `null`), the backend already COALESCEd NULL→0 (§2.2), and the
> `?? 0` at the current call sites only guards the **optional** `cacheCreationTokens`
> / `cacheReadTokens` fields (`number | undefined`) — `totalInputTokens` /
> `totalOutputTokens` have **no** `?? 0` because they are required `number`. There
> is no `null` anywhere in the web layer to key off.
>
> Because this phase is **web-only** (we cannot change the backend to stop
> COALESCing for Cursor), the **only** signal available is the agent identity.
> **Recommendation (implemented below): render "not captured" for the four token
> cells of any row whose `agent === 'CURSOR'`** (referenced through the typed
> `AgentKind` constant, §3.2). This is honest and permanent: Cursor stays all-null
> until Phase 8 lands, and the phase spec explicitly calls this "the permanent
> state, not a transient one."
>
> Rejected alternative: gate on "agent is Cursor AND all four token values are
> 0". That re-introduces the exact ambiguity we are removing (it can't tell a
> not-captured Cursor period from a genuine-zero one), so it is strictly worse.
> Use pure agent-identity gating.
>
> Rejected alternative: change `proxai_nest` to emit `null` for Cursor and widen
> the web type to `number | null`. That is a cross-repo change with real blast
> radius (the SQL, the wire type, every `?? 0` consumer) and is explicitly out of
> scope for a web-only display phase.

---

## 3. CHANGE 1 — KPI subtitle (`agent-metrics-dashboard.tsx`)

**File:** `app/dashboard/organization/(workspace)/analytics/acr/_components/agent-metrics-dashboard.tsx`

The "tokens" entry of the local `AGENT_METRICS` array currently reads (verified
lines 41-52):

```tsx
  {
    key: 'tokens',
    title: 'Token Usage',
    icon: <IconCpu stroke={1.5} className={iconClass} />,
    extractor: (p) => p.actual.totalTokenCount + p.cached.totalTokenCount,
    formatValue: formatNumber,
    summaryPicker: (actual, cached) =>
      actual.totalTokenCount + cached.totalTokenCount,
    subtitle: 'Input + output tokens',
    aggregateValue: (actual, cached) =>
      formatNumber(actual.totalTokenCount + cached.totalTokenCount),
  },
```

**Change only the `subtitle` line.** Find:

```tsx
    subtitle: 'Input + output tokens',
```

Replace with:

```tsx
    subtitle: 'Input + output + cache-read tokens',
```

Do **not** touch `extractor`, `summaryPicker`, or `aggregateValue` — the value is
already correct; only its caption was understating it. Do **not** touch the
`queries` entry. Do **not** touch the SDK `metric-defs.tsx` (§9).

---

## 4. CHANGE 2 — Cursor "not captured" (`acr-stats-org-source-table.tsx`)

**File:** `app/dashboard/organization/(workspace)/analytics/acr/_components/acr-stats-org-source-table.tsx`

This is the per-agent breakdown table (`AgentSourceStatsTable`). `entry.agent`
holds the agent kind (`CLAUDE_CODE` / `CURSOR` / `CODEX` / `GEMINI_CLI`) — it is
mapped from `p.provider` in `agent-analytics-content.tsx` (`agentEntries`,
`selectedEntries`, and `AgentGroupTablePanel`), so the same row shape feeds every
use of this table. `entry.agent` is typed `string | null`.

### 4.1 Extend the imports

Find the current import of the entry type (verified line 13):

```tsx
import type { AgentStatsAgentEntry } from '@/services/organization';
```

Replace with (add `AgentKind`, which is exported from the same barrel via
`services/organization/acr-stats-org.types.ts:32`):

```tsx
import type { AgentStatsAgentEntry, AgentKind } from '@/services/organization';
```

Add a `ReactNode` type import at the top of the import block (the file is a
`'use client'` component; it currently imports no React symbols). Add this as the
**first** import line, immediately under `'use client';`:

```tsx
import type { ReactNode } from 'react';
```

`Typography` is already imported from `'proxai-ui'` (verified lines 4-12) — reuse
it; do not add another import for it.

### 4.2 Add the typed Cursor constant + the render helper

Insert this block **immediately after the import block and before
`interface Props`** (around current line 22):

```tsx
/**
 * Cursor token collection is deferred, so its input / output / cache columns are
 * structurally absent: the backend stores NULL and COALESCEs to 0 on the wire,
 * which is indistinguishable from a genuine zero. Agent identity is the only
 * signal available client-side, so Cursor's token cells read "not captured" to
 * keep no-data distinct from real-zero usage. Typed against AgentKind so a
 * rename of the wire-contract agent set fails at compile time.
 */
const CURSOR_AGENT: AgentKind = 'CURSOR';

const TOKENS_NOT_CAPTURED_LABEL = 'not captured';

function renderTokenCell(notCaptured: boolean, value: number): ReactNode {
  if (notCaptured) {
    return (
      <Typography as="span" variant="body" color="tertiary">
        {TOKENS_NOT_CAPTURED_LABEL}
      </Typography>
    );
  }
  return formatTokens(value);
}
```

### 4.3 Compute the per-row flag

Inside the `sorted.map((entry) => { ... })` body, the current code computes
`label`, `avg`, and `share` (verified lines 69-78). Add the flag right after the
`share` computation, before `return (`:

```tsx
            const tokensNotCaptured = entry.agent === CURSOR_AGENT;
```

### 4.4 Route the four token cells through the helper

Find the four token `<TableCell>`s (verified lines 100-113):

```tsx
                <TableCell className="text-right align-middle font-mono">
                  {formatTokens(entry.providerStatsData.totalInputTokens)}
                </TableCell>
                <TableCell className="text-right align-middle font-mono">
                  {formatTokens(entry.providerStatsData.totalOutputTokens)}
                </TableCell>
                <TableCell className="text-right align-middle font-mono">
                  {formatTokens(
                    entry.providerStatsData.cacheCreationTokens ?? 0
                  )}
                </TableCell>
                <TableCell className="text-right align-middle font-mono">
                  {formatTokens(entry.providerStatsData.cacheReadTokens ?? 0)}
                </TableCell>
```

Replace with (preserve the `?? 0` on the optional fields — those guard
`undefined`, a separate concern from the Cursor display):

```tsx
                <TableCell className="text-right align-middle font-mono">
                  {renderTokenCell(
                    tokensNotCaptured,
                    entry.providerStatsData.totalInputTokens
                  )}
                </TableCell>
                <TableCell className="text-right align-middle font-mono">
                  {renderTokenCell(
                    tokensNotCaptured,
                    entry.providerStatsData.totalOutputTokens
                  )}
                </TableCell>
                <TableCell className="text-right align-middle font-mono">
                  {renderTokenCell(
                    tokensNotCaptured,
                    entry.providerStatsData.cacheCreationTokens ?? 0
                  )}
                </TableCell>
                <TableCell className="text-right align-middle font-mono">
                  {renderTokenCell(
                    tokensNotCaptured,
                    entry.providerStatsData.cacheReadTokens ?? 0
                  )}
                </TableCell>
```

### 4.5 What you must NOT touch in this file

- **RECORDS, TOOL CALLS, AVG DURATION cells** stay numeric for every agent
  (Cursor's record / tool-call / duration data is real; only its **tokens** are
  uncaptured). Do not "not-capture" those columns.
- The empty-state branch, the sort, the `share` / `avg` math, and the
  `formatProviderName` label all stay as-is. `formatProviderName('CURSOR')`
  already renders "Cursor".

---

## 5. Tests

Runner is **Vitest** (`environment: 'happy-dom'`, `@testing-library/react` +
`@testing-library/jest-dom` via `vitest.setup.ts`). Tests live in sibling
`_tests/` folders and are named `*.test.tsx`. Run one file with
`bun run test <path>` (the `test` script is `vitest run`).

### 5.1 KPI subtitle test

**File:** `app/dashboard/organization/(workspace)/analytics/acr/_components/_tests/agent-metrics-dashboard.test.tsx`

The file already imports `{ render, screen }` from `@testing-library/react`,
`{ vi }` from `vitest`, `{ emptyCounters }`, and mocks the `chart-view-store`. Add
this `it(...)` inside the existing `describe('AgentMetricsDashboard', …)` block.
The subtitle renders in single (non-comparison) mode regardless of series content:
`MetricSummary` always emits `def.subtitle` in non-comparison mode, and
`DataWidget` always renders its `headerContent` (verified
`proxai-ui/components/data-widget/data-widget.tsx:541`).

```tsx
  it('labels the Token Usage KPI as a three-column input + output + cache-read sum', () => {
    render(
      <AgentMetricsDashboard
        series={[]}
        comparison={false}
        orgId="org_1"
        teams={[]}
        members={[]}
        membership={null}
      />
    );

    expect(
      screen.getByText('Input + output + cache-read tokens')
    ).toBeInTheDocument();
  });
```

### 5.2 Cursor + genuine-zero source-table tests

**File:** `app/dashboard/organization/(workspace)/analytics/acr/_components/_tests/acr-stats-org-source-table.test.tsx`

First extend the existing testing-library import so `within` is available:

```tsx
import { render, screen, within } from '@testing-library/react';
```

(The file currently imports `{ render, screen }`. `within` is already used by
sibling tests, e.g. `../../sdk/_components/_tests/sdk-stats-org-provider-table.test.tsx`.)

Then add these two `it(...)` cases inside the existing
`describe('AgentSourceStatsTable', …)` block. `emptyCounters()` yields all-zero
token fields, which is exactly the on-wire Cursor shape:

```tsx
  it('renders "not captured" for Cursor token cells instead of a misleading zero', () => {
    render(
      <AgentSourceStatsTable
        entries={[
          {
            agent: 'CURSOR',
            providerStatsData: { ...emptyCounters(), totalQueries: 7 },
            cachedStatsData: emptyCounters(),
          },
        ]}
      />
    );

    const cursorRow = screen.getByText('Cursor').closest<HTMLElement>('tr');
    expect(cursorRow).not.toBeNull();

    // The four token columns (input / output / cache-create / cache-read)
    // read "not captured", not "0".
    expect(
      within(cursorRow!).getAllByText('not captured')
    ).toHaveLength(4);

    // RECORDS still shows the real count — only tokens are uncaptured.
    expect(within(cursorRow!).getByText('7')).toBeInTheDocument();
  });

  it('renders genuine zero tokens as "0" for a token-capturing agent', () => {
    render(
      <AgentSourceStatsTable
        entries={[
          {
            agent: 'CLAUDE_CODE',
            providerStatsData: { ...emptyCounters(), totalQueries: 3 },
            cachedStatsData: emptyCounters(),
          },
        ]}
      />
    );

    const row = screen.getByText('Claude Code').closest<HTMLElement>('tr');
    expect(row).not.toBeNull();

    // A token-capturing agent never shows "not captured"...
    expect(within(row!).queryByText('not captured')).toBeNull();
    // ...and its zero-valued token cells render "0".
    expect(within(row!).getAllByText('0').length).toBeGreaterThan(0);
  });
```

> Why these assertions hold: `formatProviderName('CURSOR') === 'Cursor'` and
> `'CLAUDE_CODE' → 'Claude Code'` (verified `lib/format/humanize.ts:50-71`).
> `formatTokens(0) === '0'` and `formatInteger(7) === '7'` (verified
> `_lib/format-counters.ts:10-18`). The Cursor row's four token cells are the only
> "not captured" nodes (RECORDS=7, TOOL CALLS=0, AVG DURATION=0ms are numeric).
> `el.closest<HTMLElement>('tr')` uses the generic `Element.closest` overload — no
> cast, no `any`; `cursorRow!` is a non-null assertion after an explicit
> `not.toBeNull()` check.

> The existing source-table test
> `'handles missing/undefined optional counters gracefully…'` deletes
> `cacheCreationTokens` / `cacheReadTokens` on a `CLAUDE_CODE` row and asserts
> 8 cells mount. It stays green: `renderTokenCell(false, undefined ?? 0)` →
> `formatTokens(0)` → `'0'`, same as today. Re-run it to confirm.

---

## 6. Audit / self-check before hand-back

Run these from the `proxai_web` repo root. All are read-only.

```bash
# 1) The KPI subtitle was updated and the value math is untouched.
grep -n "Input + output + cache-read tokens\|totalTokenCount" \
  "app/dashboard/organization/(workspace)/analytics/acr/_components/agent-metrics-dashboard.tsx"
#   → subtitle string present; the three `totalTokenCount` value lines unchanged.

# 2) Cursor is gated through the typed constant, not a loose literal at the compare site.
grep -n "CURSOR_AGENT\|not captured\|renderTokenCell" \
  "app/dashboard/organization/(workspace)/analytics/acr/_components/acr-stats-org-source-table.tsx"

# 3) No web total / KPI folds cacheCreation into a sum (it is a non-additive subset).
grep -rn "cacheCreationTokens" app/ services/ | grep -v "\.test\." | grep -v "emptyCounters"
#   → in the ACR area cacheCreationTokens appears ONLY as a displayed cell
#     (acr-stats-org-source-table.tsx) — never inside a `+` that also adds
#     totalTokenCount / input / output / cacheRead. (The SDK aggregate at
#     sdk/_lib/sdk-stats-org-aggregate.ts maintains its OWN cacheCreationTokens
#     column; it does NOT add it into totalTokenCount. Out of scope; do not touch.)

# 4) You did not touch the SDK dashboard's matching subtitle.
grep -rn "Input + output" app/ | grep -v "\.test\."
#   → exactly TWO hits: agent-metrics-dashboard.tsx (now the new string) and
#     sdk/_components/metric-defs.tsx (UNCHANGED — out of scope, §9).
```

If grep #3 ever shows `cacheCreationTokens` inside a path that also adds
`totalTokenCount`/input/output/cacheRead into one number, **stop and report it**
in your hand-back (it would be an F3 double-count) — do **not** silently "fix" it.

---

## 7. Execution order & commands

1. Edit `agent-metrics-dashboard.tsx` (§3) — one subtitle string.
2. Edit `acr-stats-org-source-table.tsx` (§4) — imports, constant + helper,
   per-row flag, four token cells.
3. Add the tests (§5).
4. Run (do **NOT** run `bun run validate` while iterating):
   ```bash
   bun run typecheck
   bun run test "app/dashboard/organization/(workspace)/analytics/acr/_components/_tests/agent-metrics-dashboard.test.tsx"
   bun run test "app/dashboard/organization/(workspace)/analytics/acr/_components/_tests/acr-stats-org-source-table.test.tsx"
   bun run lint
   ```
   (Quote the paths — the `(workspace)` route group has parentheses the shell
   would otherwise interpret.)

If any command fails, fix the cause — never silence it with a suppression or an `any`.

---

## 8. Hand-back report (send this back to the orchestrator/verifier)

1. **Files changed** (path + one line each), all four.
2. **The two source diffs** pasted verbatim (`agent-metrics-dashboard.tsx`
   subtitle; `acr-stats-org-source-table.tsx` imports + constant + helper + cells).
3. **Test results**: paste the green output of the two `bun run test <file>`
   commands and `bun run typecheck`.
4. **Confirm the flagged decision (§2.3)** was implemented as written: detection
   is by `entry.agent === CURSOR_AGENT` (agent identity), NOT by a null/zero
   value check, and the typed `CURSOR_AGENT: AgentKind` constant is used.
5. **Audit-grep #3 result (§6)**: state whether any web total adds
   `cacheCreationTokens`. If yes — describe it and **do not change it**; flag it.
6. **Confirm you did NOT touch:** the SDK `metric-defs.tsx`, any backend
   (`proxai_nest`) file, the wire type `AnalyticsStatsData`, the KPI value
   `extractor`/`summaryPicker`/`aggregateValue`, or RECORDS/TOOL CALLS/AVG DURATION
   cells.
7. **Anything you could not do without an `any`/suppression** — name the type
   friction instead of working around it.

---

## 9. Acceptance criteria (the verifier checks all)

- [ ] The "Token Usage" KPI subtitle reads **"Input + output + cache-read
      tokens"** (or an equally accurate three-column phrasing) and the KPI value
      math is unchanged.
- [ ] A `CURSOR` row in the per-agent table renders **"not captured"** in all
      four token cells (INPUT, OUTPUT, CACHE CREATE, CACHE READ).
- [ ] A token-capturing agent (e.g. `CLAUDE_CODE`) with genuinely zero tokens
      still renders **"0"** — "not captured" is distinct from genuine zero.
- [ ] Cursor's RECORDS / TOOL CALLS / AVG DURATION cells stay numeric.
- [ ] No web total or KPI adds `cacheCreationTokens` (verified by §6 grep #3).
- [ ] The new KPI-subtitle test and the two source-table tests are green; the
      pre-existing tests in both files stay green; `typecheck` and `lint` pass.
- [ ] No `any`, no suppression comments, no before/after references; the Cursor
      check goes through the typed `AgentKind` constant.

---

## 10. Out of scope (do NOT do these — other phases or non-goals)

- **The SDK dashboard's matching subtitle** (`../../sdk/_components/metric-defs.tsx:90`,
  also `'Input + output tokens'`) — that powers the **SDK** stats dashboard, a
  separate subsystem with its own aggregation (`sdk-stats-org-aggregate.ts`). The
  phase spec scopes this fix to the **agent** (ACR) dashboard only. Leave the SDK
  string unchanged; if its KPI has the same shape it is a separate concern.
- **Any backend change.** Do not edit `proxai_nest` to emit `null` for Cursor or
  to change the `COALESCE(SUM(...), 0)`. Web-only phase.
- **The wire type `AnalyticsStatsData`.** Do not widen any token field to
  `number | null` — the wire never carries null (§2.2), and widening it would
  ripple through every `?? 0` consumer for no benefit.
- **Cursor collection itself (Phase 8, DEFERRED).** You are honestly displaying
  the absence, not adding capture.
- **Adding `cacheCreation` to any total / KPI.** It is a non-additive subset of
  `inputTokens` (ROADMAP "Column normalization"); the KPI already excludes it,
  which is correct. If `cacheCreation` is ever surfaced as a standalone number,
  label it "of which cache-write" — never as an additive line (not this phase).
- **Reasoning-token columns** — explicitly deferred (ROADMAP "Decisions LOCKED" #1).

### Cross-phase dependencies

- **Depends on Phase 3 (Gemini phantom cache_creation) — semantic only, NOT a
  code dependency.** Phase 3 zeroes Gemini's phantom `cacheCreation` so the
  normalized columns the label describes are accurate org-wide. The web code here
  is independent of Phase 3's code: the KPI already excludes `cacheCreation`, and
  the label change is a pure string. The merge order matters for *accuracy of the
  story*, not for *compilation* — this PR can be implemented and tested standalone.
- **No dependency on Phase 8 (Cursor collection, DEFERRED).** Cursor staying
  all-null is exactly why "not captured" is the correct permanent display.
- **Orchestrator quick-check note:** the spec's quick-check greps
  `agent-metrics-dashboard.tsx` for both `"Input + output"` AND `"not captured"`.
  The subtitle lives in `agent-metrics-dashboard.tsx`; the **"not captured"**
  rendering lives in `acr-stats-org-source-table.tsx` (a different file). When the
  orchestrator runs that check, point it at the source table for the
  "not captured" half — the spec grep path conflates the two files.
