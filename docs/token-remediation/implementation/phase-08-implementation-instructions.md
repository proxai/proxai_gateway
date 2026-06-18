# Phase 8 — Implementation Instructions (Cursor local-only collection)

> ## ⏸️ STATUS: DEFERRED — DO NOT IMPLEMENT UNTIL THE OPERATOR REACTIVATES.
>
> This phase is parked by operator decision (2026-06-17, `../ROADMAP.md` →
> "Decisions LOCKED" #3 and the status board row #8). Cursor stays **all-null on
> the billed token columns** for now. The honest "not captured" Cursor display
> still ships separately in **Phase 10** and does NOT depend on this phase.
>
> This document is a *ready-to-execute* plan kept on ice. If the operator says
> "reactivate Phase 8," everything below is source-verified and copy-paste
> precise as of 2026-06-17. If you are an implementer and you arrived here
> WITHOUT an explicit reactivation instruction in the current prompt: **stop —
> do not write code.** Report that Phase 8 is deferred and await instruction.

> **Audience:** the implementer model that will write the code IF reactivated.
> **Author:** orchestrator chat (source-verified against both repos on 2026-06-17).
> **Companion docs (already settled — do not re-open):**
> `../phase-08-cursor-local-collection.md`, `../ROADMAP.md`,
> `../analysis/CURSOR_TOKEN_COLLECTION.md` (the full investigation),
> `../analysis/CROSS-SOURCE-NORMALIZATION.md`.
>
> Every file path, line, and code block below was read from the actual source.
> **Follow it literally.** If line numbers have drifted, trust the *named symbol*
> (function / interface name), not the line number, and apply the same change at
> the symbol.

---

## 0. TL;DR — what this phase is (and is NOT)

Cursor contributes **all-null** billed token fields (`inputTokens` / `outputTokens`
/ `cacheReadInputTokens` / `cacheCreationInputTokens`). The investigation
(`../analysis/CURSOR_TOKEN_COLLECTION.md`) proved **exhaustively** that per-turn
*billed* tokens are **genuinely absent** from Cursor's local data: every bubble's
`tokenCount` is `{0,0}`, every composer's `usageData` is `{}`, there is no
`usageUuid`, and the only real-token source (Cursor's **Team Admin API**) is
team-admin-scoped and was **descoped** by the operator.

So this is **NOT a token-detection fix.** There is no billed-token source to
recover. It is a **feature-add (Option A)** that surfaces the *one* token-shaped
signal Cursor *does* store and that we currently throw away: an **input-context
size gauge** (`contextTokensUsed` / `contextTokenLimit` / `contextUsagePercent`,
plus the per-turn `contextWindowStatusAtCreation`), reported in `agent_metadata`,
**never** in the billed `inputTokens` column. The four billed columns **stay
null** (truthful).

**Total surface (IF reactivated):**

- **`proxai_nest`** (P1 — composer data already in S3): 3 files —
  `cursor.utils.ts` (type the new composer fields), `cursor-parse-chat.service.ts`
  (pin them in the accumulator), `cursor-finalize-turn.service.ts` (emit them into
  `agent_metadata` via the shared `buildAgentMetadata`). Plus the per-turn gauge
  read off the user bubble. Tests under `cursor/services/tests/` and
  `cursor/extractors/tests/`.
- **`proxai_gateway`** (P2 — new captures only): 1 line in `process-rows.ts`
  (`CURSOR_BUBBLE_KEEP_KEYS`) so the per-turn gauge survives the bubble trim. One
  test in `tests/trim.test.ts`.

There is **no schema change, no migration, no new queue, no new module, no
declaredFields change** (the gauge rides inside the existing `agent_metadata`
JSONB bag, not as a newly-declared extractable field — see §3.0 and the DECISION
in §3.5).

---

## 1. Hard rules (apply to BOTH repos — non-negotiable)

Enforced by lint/CI and human reviewers. Violating any one fails the phase.

- **No `any`.** Not `: any`, `as any`, `Promise<any>`, `Record<string, any>`,
  generic default `= any`, or implicit any — in `.ts` **and** `.spec.ts` /
  `.test.ts`. Use `unknown` + a type guard at boundaries. If a third-party type
  *forces* an any, **stop and report it**, don't insert one.
- **No suppression comments.** No `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`,
  `eslint-disable`, `oxlint-disable`, `v8 ignore`. Fix the type, don't silence the
  tool.
- **No "before/after" references** in code, comments, or test names. Describe
  *current* behavior only. Test names describe behavior
  (`it('surfaces the composer context-size gauge in agent_metadata', …)`), never
  mechanics or line numbers.
- **Comments explain *why*, not *what*.** No banners.
- **No hardcoded enum-string values.** Import the Prisma enum or the matching
  `*.constants.ts` const-object. (Not directly relevant here — Cursor's literals
  are source-format JSON keys, not Prisma enums — but the rule holds.)
- **Package manager is `bun`** in both repos. Never `npm`/`pnpm`/`yarn`.
- **Tests:** `proxai_nest` uses Vitest via `bun run test:unit <path>`;
  `proxai_gateway` runs on Bun via `bun test <path>`. Do **not** run the full
  `bun run validate` gate while iterating — run the file-specific test + `bun run
  typecheck`.
- **Git:** do **not** commit/push/branch/stage unless the operator tells you to.
  Leave edits in the working tree.

---

## 2. Mental model — READ THIS BEFORE WRITING CODE

### 2.1 The blocker, stated honestly (do NOT try to engineer around it)

Cursor bills **server-side**. The desktop client writes **placeholder** token
counts to its local SQLite store. Verified on a real machine
(`../analysis/CURSOR_TOKEN_COLLECTION.md` §0–§1, typed `json_extract` over the
924 MB `state.vscdb`, NOT substring greps — raw "token" greps are false positives
because the payloads contain the user's own source code about tokens):

| Signal | Where | Value observed |
|---|---|---|
| `bubble.tokenCount` | every `bubbleId:` row | `{0,0}` on **all 20,262** bubbles (SUM=0, MAX=0) |
| `composer.usageData` | every `composerData:` row | `{}` on **all 318** composers |
| `usageUuid` | anywhere | **does not exist** |
| Real billed `{input,output,cacheWrite,cacheRead}` | Cursor **Team Admin API** `/teams/filtered-usage-events` | team-admin-only, separate key, whole-team scope — **DESCOPED** |

**Conclusion: there is no first-party per-user path to real billed Cursor
tokens.** Do **not** invent one. Do **not** populate `inputTokens` /
`outputTokens` / `cacheReadInputTokens` / `cacheCreationInputTokens` with a
context-size number, an estimate, or anything else under Option A. They stay
`null` because that is the truth.

### 2.2 The signal that DOES exist — an input-CONTEXT gauge

Cursor *does* persist how full the conversation's context window is. Two
granularities (measured values from the same machine, for reality-check):

| Datum | Source field | Granularity | Measured range |
|---|---|---|---|
| `contextTokensUsed` / `contextTokenLimit` / `contextUsagePercent` | `composerData:` row | conversation (latest snapshot) | **237/319** composers; used **10,780 → 793,224**; limit up to **1,000,000** |
| `promptTokenBreakdown` | `composerData:` row | conversation | 1 sample: `totalUsedTokens 114,724 / maxTokens 200,000` → system 470, tools 7,432, rules 21,742, skills 3,822, mcp 3,666, subagents 817, conversation 76,775 |
| `contextWindowStatusAtCreation.{tokensUsed,tokenLimit}` | `bubbleId:` user-turn row | **per-turn** | **93** user bubbles; `tokensUsed` **27,249 → 200,000**, **monotonic within a conversation** |
| `totalLinesAdded` / `totalLinesRemoved` | `composerData:` row | conversation | Σ 60,039 / Σ 27,237 (productivity, authoritative) |
| `modelConfig.modelName` | `composerData:` row | conversation | already surfaced today (`PinnedComposerHeader.modelName`) |

The composer-level fields (`contextTokensUsed`, `contextTokenLimit`,
`contextUsagePercent`, `promptTokenBreakdown`, `totalLinesAdded`,
`totalLinesRemoved`) are **already in our production S3 captures, unextracted** —
the gateway ships `composerData:` rows **untrimmed** (verified: §2.4). So P1 needs
**no gateway change** and is **retroactively backfillable** (Phase 11 re-parse
recovers it on existing Cursor ACRs).

The per-turn `contextWindowStatusAtCreation` lives on the `bubbleId:` user row and
is **trimmed out** by the gateway today (`CURSOR_BUBBLE_KEEP_KEYS`) — recovering it
is the one-line gateway change P2, and it takes effect on **new captures only**.

### 2.3 The gauge-vs-flow rule (CRITICAL — break it and you over-count catastrophically)

Cursor's context-token fields are a **gauge**, not a **flow**. Each turn's
`tokensUsed` already contains *all prior turns'* context (monotonic 50k → 180k
through a single conversation). Therefore:

- Conversation-level context = the **latest snapshot** (the last non-null
  composer write — `pinComposer` keeps the freshest value via `incoming ?? prior`,
  it does **not** compute a MAX), **never a SUM** of the per-turn `tokensUsed`.
  Cursor's per-turn `tokensUsed` is monotonic within a conversation, so the latest
  snapshot is normally also the largest; but a later composer rewrite carrying a
  **lower** value (context compaction / clear) WILL lower the pinned gauge — that
  is latest-non-null-wins, which is the intended behavior (see the §5.2
  `pinComposer` test for the lowered-value case).
- **Never** place a context-size value in the billed `inputTokens` column. Any
  downstream path that `SUM`s `inputTokens` across turns would over-count
  catastrophically (it would compound the F3 Gemini double-count shape in
  `../analysis/VERIFICATION_FINDINGS.md`).
- The home for every gauge value is the **`agent_metadata` JSONB bag**, which no
  aggregate sums.

### 2.4 Why P1 is free: composer rows already ship untrimmed (verified)

`proxai_gateway/src/sources/cursor/process-rows.ts` → `trimCursorRowValue(key,
value)` (lines 147-170) only special-cases two key prefixes — `bubbleId:` (calls
`trimCursorBubbleValue`, the keep-list) and `agentKv:blob:` (drops env-wrapper /
reasoning). **Everything else, including `composerData:`, returns `value`
unchanged** (line 169 `return value;`). Confirmed by the existing test
`tests/trim.test.ts` line 90-92:

```ts
const composer = JSON.stringify({ composerId: 'x', name: 'thread', conversationState: '~b64' });
expect(trimCursorRowValue('composerData:x', composer)).toBe(composer); // untouched
```

So `contextTokensUsed` & friends are already in S3 on every Cursor capture. P1 is
purely a nest-side extraction.

### 2.5 Worked example (what the record looks like after Option A)

A Cursor conversation whose latest composer snapshot reads `contextTokensUsed:
114724`, `contextTokenLimit: 200000`, `contextUsagePercent: 57`, with a per-turn
user bubble carrying `contextWindowStatusAtCreation: { tokensUsed: 114724,
tokenLimit: 200000 }`:

```jsonc
// result.usage — UNCHANGED, still all-null (truthful: Cursor has no billed tokens)
"usage": {
  "input_tokens": null,
  "output_tokens": null,
  "cache_read_input_tokens": null,
  "cache_creation_input_tokens": null,
  "tokens_are_estimated": false,
  "service_tier": null,
  "thread_cumulative_tokens": null
}

// agent_metadata — NEW gauge fields (this is the entire deliverable)
"agent_metadata": {
  "cwd": "/Users/x/repo",
  "unified_mode": "agent",
  "force_mode": "edit",
  "is_agentic": true,
  "tool_calls": { "Read": 3, "Edit": 1 },
  "context_tokens_used": 114724,        // gauge: latest composer snapshot
  "context_token_limit": 200000,        // gauge
  "context_usage_percent": 57,          // gauge
  "prompt_token_breakdown": { /* system/tools/rules/... */ },
  "total_lines_added": 231,             // authoritative productivity
  "total_lines_removed": 88,            // authoritative productivity
  "turn_context_tokens": 114724         // per-turn gauge (P2; new captures only)
}
```

Three turns of the same conversation each carry their own `turn_context_tokens`
(50k, 90k, 114k) — and you **MUST NOT** sum those into anything. The
conversation-level `context_tokens_used` is the **latest composer snapshot** (the
last non-null composer write), not a computed MAX — usually the same number
because Cursor's gauge rises monotonically, but it would track a lower value if a
later composer rewrite reported one.

---

## 3. Change spec — `proxai_nest` (P1 + per-turn read)

> All four nest files below are under
> `src/agent-gateway/parsers/cursor/`. The billed `result.usage` block stays
> exactly as it is (all-null) — see §3.4 for why the usage *extractors* are NOT
> the place for this and stay null-extractors.

### 3.0 Where the gauge lands — the load-bearing architectural fact

**The stored `result.usage` columns for Cursor are HARDCODED null in
`cursor-finalize-turn.service.ts` — they are NOT read from the usage
extractors.** Verified at `cursor-finalize-turn.service.ts:362-377`:

```ts
    result: {
      content: resultContent,
      final_text: getValue<string>('result.final_text'),
      stop_reason: getValue<string>('result.stop_reason'),
      usage: {
        input_tokens: null,
        output_tokens: null,
        tokens_are_estimated: false,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        service_tier: null,
        thread_cumulative_tokens: null,
      },
      // ...
```

The usage extractors (`extractors/usage.ts`) are read only to compute the
`agent_gateway_parser_cursor_usage_present_total` *metric* (lines 283-290), not to
fill the stored columns. **This means editing the usage extractors would NOT
change the stored columns — so don't.** The gauge goes into `agent_metadata`,
assembled by the shared `buildAgentMetadata(...)` helper (lines 420-434), which is
the single emit site used by BOTH the normal finalize path AND the agentKv path
(`cursor-agent-kv-turn.service.ts:246`). That helper is the lowest-blast-radius
place to add gauge fields.

> **Correction to the phase spec:** `../phase-08-cursor-local-collection.md`
> frames P1 as editing `cursor/extractors/usage.ts:28-50` + `cursor.utils.ts:42-63`
> + `declaredFields`. Reality: (a) the null-extractors live at
> `extractors/usage.ts:40-51` (factory at 29-38) and must **stay null** because
> the stored columns are hardcoded null and are the truthful billed values; (b)
> the gauge belongs in `buildAgentMetadata` (`cursor-finalize-turn.service.ts:420`),
> threaded via `PinnedComposerHeader`; (c) **no `declaredFields` change is needed**
> because `agent_metadata` is a JSONB bag, not a per-field-declared extractor — see
> the DECISION in §3.5.

### 3.1 `cursor.utils.ts` — type the new composer-header fields

**File:** `src/agent-gateway/parsers/cursor/cursor.utils.ts`

`CursorComposerHeader` (lines 42-63) already types `contextUsagePercent?: number`
and absorbs everything else via `[key: string]: unknown`. Add explicit typings for
the gauge fields we will read, so `pinComposer` can read them without a cast.
Find:

```ts
export interface CursorComposerHeader {
  _v: number;
  composerId: string;
  status?: string; // 'completed' | 'none' | undefined
  unifiedMode?: string; // 'agent' | 'chat'
  forceMode?: string; // 'edit' | 'chat'
  modelConfig?: { modelName?: string };
  isAgentic?: boolean;
  fullConversationHeadersOnly?: Array<{ bubbleId: string; type: number }>;
  contextUsagePercent?: number;
```

Add the five sibling fields immediately after `contextUsagePercent?: number;`
(paste the block verbatim — it adds `contextTokensUsed`, `contextTokenLimit`,
`promptTokenBreakdown`, `totalLinesAdded`, `totalLinesRemoved`):

```ts
  contextUsagePercent?: number;
  /**
   * Input-context-size GAUGE (NOT a billed token count). Cursor maintains the
   * fill level of the conversation's context window; it rises monotonically
   * through a conversation, so it is reported as the latest snapshot and never
   * summed. Surfaced into agent_metadata only.
   */
  contextTokensUsed?: number;
  contextTokenLimit?: number;
  /** Category split of the context-size gauge (system/tools/rules/skills/mcp/conversation). */
  promptTokenBreakdown?: Record<string, unknown>;
  /** Authoritative code-change volume for the conversation (additive, but reported as-is). */
  totalLinesAdded?: number;
  totalLinesRemoved?: number;
```

Then add a per-turn bubble field. Find the `CursorBubble` interface (lines 94-111)
and add `contextWindowStatusAtCreation` after `context?:`:

```ts
  context?: {
    selections?: CursorBubbleSelection[];
    fileSelections?: CursorBubbleSelection[];
    [key: string]: unknown;
  };
  /**
   * Per-turn input-context-size GAUGE on the user bubble (P2; survives the
   * gateway trim only after the keep-key add). Reported as agent_metadata
   * turn_context_tokens — a gauge, never summed, never in inputTokens.
   */
  contextWindowStatusAtCreation?: {
    tokensUsed?: number;
    tokenLimit?: number;
    percentageRemaining?: number;
    [key: string]: unknown;
  };
  // forward-compat
  [key: string]: unknown;
```

### 3.2 `cursor-parse-chat.service.ts` — pin the gauge fields in the composer header

**File:** `src/agent-gateway/parsers/cursor/services/cursor-parse-chat.service.ts`

The composer-level gauge is pinned into `PinnedComposerHeader` (defined in
`cursor-finalize-turn.service.ts`, see §3.3) by `pinComposer` (lines 886-904).
Extend its `incoming` param type and its return object. Find:

```ts
function pinComposer(
  prior: PinnedComposerHeader | null,
  incoming: {
    _v: number;
    modelConfig?: { modelName?: string };
    unifiedMode?: string;
    forceMode?: string;
    isAgentic?: boolean;
  },
): PinnedComposerHeader {
  return {
    modelName: incoming.modelConfig?.modelName ?? prior?.modelName ?? 'default',
    unifiedMode: incoming.unifiedMode ?? prior?.unifiedMode ?? 'agent',
    forceMode: incoming.forceMode ?? prior?.forceMode ?? null,
    isAgentic: incoming.isAgentic ?? prior?.isAgentic ?? null,
    composerSchemaVersion: incoming._v,
    bubbleSchemaVersion: prior?.bubbleSchemaVersion ?? null,
  };
}
```

Replace with (latest-snapshot wins — `incoming ?? prior` keeps the freshest
composer rewrite, which is the gauge semantic we want):

```ts
function pinComposer(
  prior: PinnedComposerHeader | null,
  incoming: {
    _v: number;
    modelConfig?: { modelName?: string };
    unifiedMode?: string;
    forceMode?: string;
    isAgentic?: boolean;
    contextTokensUsed?: number;
    contextTokenLimit?: number;
    contextUsagePercent?: number;
    promptTokenBreakdown?: Record<string, unknown>;
    totalLinesAdded?: number;
    totalLinesRemoved?: number;
  },
): PinnedComposerHeader {
  return {
    modelName: incoming.modelConfig?.modelName ?? prior?.modelName ?? 'default',
    unifiedMode: incoming.unifiedMode ?? prior?.unifiedMode ?? 'agent',
    forceMode: incoming.forceMode ?? prior?.forceMode ?? null,
    isAgentic: incoming.isAgentic ?? prior?.isAgentic ?? null,
    composerSchemaVersion: incoming._v,
    bubbleSchemaVersion: prior?.bubbleSchemaVersion ?? null,
    // Context-size GAUGE: latest composer snapshot wins (monotonic; never summed).
    contextTokensUsed: incoming.contextTokensUsed ?? prior?.contextTokensUsed ?? null,
    contextTokenLimit: incoming.contextTokenLimit ?? prior?.contextTokenLimit ?? null,
    contextUsagePercent: incoming.contextUsagePercent ?? prior?.contextUsagePercent ?? null,
    promptTokenBreakdown:
      incoming.promptTokenBreakdown ?? prior?.promptTokenBreakdown ?? null,
    totalLinesAdded: incoming.totalLinesAdded ?? prior?.totalLinesAdded ?? null,
    totalLinesRemoved: incoming.totalLinesRemoved ?? prior?.totalLinesRemoved ?? null,
  };
}
```

> **No `ACCUMULATOR_VERSION` bump.** See the DECISION in §3.5. The pinned object
> lives inside `accumulator.composerHeader`, which `loadAccumulator` restores via
> `blob.composerHeader ?? null` (line 860) — the new fields are additive within
> that object; an old blob simply restores them as `undefined`, and every reader
> below uses `?? null`. Do **not** touch `ACCUMULATOR_VERSION = 1` (line 71) or
> `emptyAccumulator()` (those reset every in-flight Cursor session's open-turn
> lineage on deploy).

### 3.3 `cursor-finalize-turn.service.ts` — extend `PinnedComposerHeader` + emit into `agent_metadata`

**File:** `src/agent-gateway/parsers/cursor/services/cursor-finalize-turn.service.ts`

**(a)** Extend the `PinnedComposerHeader` interface (lines 40-47). Find:

```ts
export interface PinnedComposerHeader {
  modelName: string;
  unifiedMode: string;
  forceMode: string | null;
  isAgentic: boolean | null;
  composerSchemaVersion: number;
  bubbleSchemaVersion: number | null;
}
```

Replace with (the six gauge fields are declared **optional** — `?:` — on purpose;
see the note below):

```ts
export interface PinnedComposerHeader {
  modelName: string;
  unifiedMode: string;
  forceMode: string | null;
  isAgentic: boolean | null;
  composerSchemaVersion: number;
  bubbleSchemaVersion: number | null;
  // Context-size GAUGE + productivity (surfaced into agent_metadata; see
  // CURSOR_TOKEN_COLLECTION.md §3). Optional + nullable: optional so a literal
  // that omits them still satisfies the interface; null when the composer
  // carried the field but with no value.
  contextTokensUsed?: number | null;
  contextTokenLimit?: number | null;
  contextUsagePercent?: number | null;
  promptTokenBreakdown?: Record<string, unknown> | null;
  totalLinesAdded?: number | null;
  totalLinesRemoved?: number | null;
}
```

> **Why optional (`?:`), not required.** Three existing **typed**
> `PinnedComposerHeader` literals omit these six fields and must keep compiling
> under `bun run typecheck` with **zero edits**: the shared `HEADER` const
> (`cursor-finalize-turn.service.spec.ts:177-184`), `sparseHeader`
> (`cursor-finalize-turn.service.spec.ts:607-614`), and the agentKv spec's
> `header()` builder (`cursor-agent-kv-turn.service.spec.ts:34-46`). If the fields
> were **required** (`contextTokensUsed: number | null`), all three literals would
> fail `TS2741 'property is missing'`. Declaring them optional keeps every literal
> valid, lets `pinComposer`'s `?? null` return satisfy the interface, and makes the
> §5.1 "omits gauge keys when the composer carried none" assertion correct (an
> omitted field reads back as `undefined`, and `buildAgentMetadata`'s `!= null`
> guard skips it). Do **not** add the fields to `HEADER` / `sparseHeader` /
> `header()` — leave those three literals untouched. (The four
> `cursor-parse-chat.service.spec.ts` composerHeader fixtures at :393/:552/:1104/
> :1162 are cast `as Prisma.JsonValue`, not checked against `PinnedComposerHeader`,
> so they are unaffected either way.)

**(b)** Compute the per-turn gauge from the user bubble and pass it to
`buildAgentMetadata`. In `finalizeTurn`, the user bubble is already located at
line 294 (`const userBubble = bubbles.find((b) => b.type === 1);`). The
`buildAgentMetadata(...)` call is at lines 394-398. Find:

```ts
    agentMetadata: buildAgentMetadata(
      getValue<string>('agent_metadata.cwd'),
      composerHeader,
      getValue<Record<string, number>>('result.tool_summary'),
    ),
```

Replace with:

```ts
    agentMetadata: buildAgentMetadata(
      getValue<string>('agent_metadata.cwd'),
      composerHeader,
      getValue<Record<string, number>>('result.tool_summary'),
      // Per-turn context-size GAUGE off the user bubble (P2; null until the
      // gateway keep-key ships and on older captures). A gauge — never summed.
      userBubble?.contextWindowStatusAtCreation?.tokensUsed ?? null,
    ),
```

**(c)** Extend `buildAgentMetadata` (lines 420-434) to fold the gauge fields in.
Find:

```ts
export function buildAgentMetadata(
  cwd: string | null,
  composerHeader: PinnedComposerHeader | null,
  toolCalls: Record<string, number> | null,
): Prisma.JsonValue {
  const meta: Record<string, unknown> = {
    cwd,
    unified_mode: composerHeader?.unifiedMode ?? null,
    force_mode: composerHeader?.forceMode ?? null,
    is_agentic: composerHeader?.isAgentic ?? null,
  };
  // v6: tool counts moved here from the dropped `tool_summary` column.
  if (toolCalls !== null) meta.tool_calls = toolCalls;
  return meta as Prisma.JsonValue;
}
```

Replace with:

```ts
export function buildAgentMetadata(
  cwd: string | null,
  composerHeader: PinnedComposerHeader | null,
  toolCalls: Record<string, number> | null,
  // Per-turn context-size gauge (user bubble's contextWindowStatusAtCreation
  // tokensUsed). Null on the agentKv path and on captures predating the keep-key.
  turnContextTokens: number | null = null,
): Prisma.JsonValue {
  const meta: Record<string, unknown> = {
    cwd,
    unified_mode: composerHeader?.unifiedMode ?? null,
    force_mode: composerHeader?.forceMode ?? null,
    is_agentic: composerHeader?.isAgentic ?? null,
  };
  // v6: tool counts moved here from the dropped `tool_summary` column.
  if (toolCalls !== null) meta.tool_calls = toolCalls;
  // Context-size GAUGE + productivity. Each is a gauge/snapshot — a downstream
  // reader MUST take max/latest, NEVER sum across turns, and these MUST NOT be
  // copied into the billed inputTokens column (which stays null for Cursor).
  // Only attach keys that are actually present so a 100%-absent field doesn't
  // bloat every record with nulls.
  if (composerHeader?.contextTokensUsed != null)
    meta.context_tokens_used = composerHeader.contextTokensUsed;
  if (composerHeader?.contextTokenLimit != null)
    meta.context_token_limit = composerHeader.contextTokenLimit;
  if (composerHeader?.contextUsagePercent != null)
    meta.context_usage_percent = composerHeader.contextUsagePercent;
  if (composerHeader?.promptTokenBreakdown != null)
    meta.prompt_token_breakdown = composerHeader.promptTokenBreakdown;
  if (composerHeader?.totalLinesAdded != null)
    meta.total_lines_added = composerHeader.totalLinesAdded;
  if (composerHeader?.totalLinesRemoved != null)
    meta.total_lines_removed = composerHeader.totalLinesRemoved;
  if (turnContextTokens != null) meta.turn_context_tokens = turnContextTokens;
  return meta as Prisma.JsonValue;
}
```

> The agentKv path (`cursor-agent-kv-turn.service.ts:246`) calls
> `buildAgentMetadata(null, composerHeader, toolSummary)` with no 4th argument —
> the default `turnContextTokens = null` keeps it compiling and correct
> (agentKv-shell turns have no per-turn bubble gauge, but they DO get the
> composer-level gauge through the shared `composerHeader`). **No edit needed
> there**, but confirm it still type-checks.

### 3.4 Leave the usage extractors UNCHANGED (and why)

`extractors/usage.ts` (lines 40-51) ships four `nullExtractor`s. **Leave them
null.** Under Option A the billed columns are truthfully null; the stored
`result.usage` block in finalize-turn is hardcoded null (§3.0) and the extractors
only feed the `cursor_usage_present_total` metric. Do **not** repurpose them for
the gauge — a gauge in `result.usage.input_tokens` is exactly the gauge-vs-flow
violation §2.3 forbids.

### 3.5 DECISIONS (flagged for the reviewer)

1. **DECISION — Option A only (recommended floor). NOT Option B/C.** Surface the
   authoritative context-size gauge + productivity; the four billed columns stay
   null. Option B (estimated `outputTokens` via tokenization, behind
   `tokens_are_estimated=true`) and Option C (context-as-input) are **held**.
   Rationale: Option A is 100% truthful, mostly already-in-S3, and has zero
   tokenizer dependency. Option B introduces a BPE-estimate across many models and
   MUST be visibly flagged to avoid diluting measured counts; it is a separable
   opt-in if the operator later wants a token number in the standard column shape.
   Option C requires a hard guarantee that *nothing downstream sums Cursor input
   across turns* — not worth the blast radius for a deferred feature-add. **If the
   operator wants B or C at reactivation time, that is a new decision — do not ship
   it silently under this plan.**

2. **DECISION — gauge lands in `agent_metadata`, NOT a new schema column and NOT a
   declared extractable field.** No `result.usage` schema column exists for
   context size, and adding one is out of scope (and would re-open the locked
   "no new token column" decision, `../ROADMAP.md` "Decisions LOCKED" #1). The
   gauge rides inside the existing `agent_metadata` JSONB bag built by
   `buildAgentMetadata`. **Consequently there is NO `declaredFields` change** in
   `parsers.versions.ts` — `agent_metadata` is a JSONB bag, not a per-field
   declared extractor (the CURSOR `declaredFields` block at
   `parsers.versions.ts:311-331` declares `agent_metadata.cwd` as a *cwd*
   extractor, not the bag; the gauge is not an `ExtractableField`). This sidesteps
   the `field_missing_total` 100%-miss cardinality trap the same block warns about
   for the billed columns.

3. **DECISION — no `ACCUMULATOR_VERSION` bump.** The pinned gauge fields are
   additive *inside* `composerHeader`; old `v1` blobs restore them as `undefined`
   and every reader uses `?? null`. Bumping `ACCUMULATOR_VERSION` (currently `1`)
   would reset every active Cursor session's accumulator on deploy and discard
   in-flight open-turn lineage for zero benefit. Keep it `1`.

4. **DECISION — "only attach present keys."** `buildAgentMetadata` attaches a
   gauge key only when its value is non-null. This keeps the JSONB compact and
   means agentKv-path / older-capture records simply don't carry the keys, rather
   than carrying `null`s. (The existing `cwd`/`unified_mode`/`force_mode`/
   `is_agentic` keys are always attached for shape stability with current data;
   the new gauge keys are sparse by design.)

---

## 4. Change spec — `proxai_gateway` (P2, new captures only)

**File:** `proxai_gateway/src/sources/cursor/process-rows.ts`

The per-turn `contextWindowStatusAtCreation` is on the `bubbleId:` user row, which
the gateway trims to a keep-list (`CURSOR_BUBBLE_KEEP_KEYS`, lines 56-67). Add the
one key so it survives. Find:

```ts
const CURSOR_BUBBLE_KEEP_KEYS = [
  '_v',
  'type',
  'bubbleId',
  'text',
  'richText',
  'createdAt',
  'capabilityType',
  'toolFormerData',
  'thinking',
  'context',
];
```

Replace with:

```ts
const CURSOR_BUBBLE_KEEP_KEYS = [
  '_v',
  'type',
  'bubbleId',
  'text',
  'richText',
  'createdAt',
  'capabilityType',
  'toolFormerData',
  'thinking',
  'context',
  // Per-turn input-context-size gauge consumed by the nest cursor parser
  // (agent_metadata.turn_context_tokens). New captures only.
  'contextWindowStatusAtCreation',
];
```

That is the **entire** gateway change. `trimCursorBubbleValue` (lines 77-85)
copies only keep-listed keys, so adding the key is sufficient — nothing else to
touch. (P2 affects **new captures only**; the field is sparse today — 93 bubbles
on the sample machine — but is expected to grow. Do **not** add a
`field_missing_total`-style emit gated on its absence: it is a JSONB passthrough,
not a declared extractor, so the cardinality trap doesn't apply.)

---

## 5. Tests

### 5.1 `proxai_nest` — finalize-turn gauge test (Vitest)

**File:** `src/agent-gateway/parsers/cursor/services/tests/cursor-finalize-turn.service.spec.ts`

This spec already has the fixture builders you need: `makeChat()`, `userBubble()`,
`assistantText()`, and the `HEADER` const (`PinnedComposerHeader`), plus a
`finalize(bubbles, overrides)` wrapper. Reuse them. Add this `describe` block (the
`HEADER` const will need the new gauge fields — extend the shared `HEADER` or
build a local header; the example below builds a local one to avoid disturbing
existing golden-record assertions):

```ts
describe('cursor agent_metadata — context-size gauge (Option A)', () => {
  const gaugeHeader: PinnedComposerHeader = {
    modelName: 'claude-opus-4-7',
    unifiedMode: 'agent',
    forceMode: 'edit',
    isAgentic: true,
    composerSchemaVersion: 13,
    bubbleSchemaVersion: 3,
    contextTokensUsed: 114724,
    contextTokenLimit: 200000,
    contextUsagePercent: 57,
    promptTokenBreakdown: { system: 470, tools: 7432, conversation: 76775 },
    totalLinesAdded: 231,
    totalLinesRemoved: 88,
  };

  it('surfaces the composer context-size gauge in agent_metadata and keeps billed columns null', () => {
    const uBubble = userBubble('u-1', 'do the thing');
    uBubble.contextWindowStatusAtCreation = { tokensUsed: 114724, tokenLimit: 200000 };
    const record = finalize([uBubble, assistantText('a-1', 'done')], {
      composerHeader: gaugeHeader,
    });
    expect(record).not.toBeNull();
    const meta = record!.agentMetadata as Record<string, unknown>;

    // Gauge fields present in agent_metadata.
    expect(meta.context_tokens_used).toBe(114724);
    expect(meta.context_token_limit).toBe(200000);
    expect(meta.context_usage_percent).toBe(57);
    expect(meta.prompt_token_breakdown).toEqual({
      system: 470,
      tools: 7432,
      conversation: 76775,
    });
    expect(meta.total_lines_added).toBe(231);
    expect(meta.total_lines_removed).toBe(88);
    expect(meta.turn_context_tokens).toBe(114724); // per-turn gauge off the user bubble

    // Billed columns remain null — the gauge is NEVER placed in result.usage.
    expect(record!.result.usage?.input_tokens).toBeNull();
    expect(record!.result.usage?.output_tokens).toBeNull();
    expect(record!.result.usage?.cache_read_input_tokens).toBeNull();
    expect(record!.result.usage?.cache_creation_input_tokens).toBeNull();
  });

  it('omits gauge keys entirely when the composer carried none (sparse by design)', () => {
    // HEADER (the existing shared const) has no gauge fields → keys absent, not null.
    const record = finalize([userBubble('u-1', 'hi'), assistantText('a-1', 'ok')]);
    expect(record).not.toBeNull();
    const meta = record!.agentMetadata as Record<string, unknown>;
    expect('context_tokens_used' in meta).toBe(false);
    expect('turn_context_tokens' in meta).toBe(false);
    // Existing always-present keys still there.
    expect('cwd' in meta).toBe(true);
    expect('unified_mode' in meta).toBe(true);
  });

  it('does not sum the per-turn gauge across a multi-turn conversation (gauge, not flow)', () => {
    // Two turns, monotonic per-turn gauge 50k then 90k. Each record carries its
    // OWN turn value; nothing accumulates them.
    const u1 = userBubble('u-1', 'turn one');
    u1.contextWindowStatusAtCreation = { tokensUsed: 50000 };
    const r1 = finalize([u1, assistantText('a-1', 'r1')], { composerHeader: gaugeHeader });

    const u2 = userBubble('u-2', 'turn two');
    u2.contextWindowStatusAtCreation = { tokensUsed: 90000 };
    const r2 = finalize([u2, assistantText('a-2', 'r2')], { composerHeader: gaugeHeader });

    const m1 = r1!.agentMetadata as Record<string, unknown>;
    const m2 = r2!.agentMetadata as Record<string, unknown>;
    expect(m1.turn_context_tokens).toBe(50000);
    expect(m2.turn_context_tokens).toBe(90000); // NOT 140000 — never summed
  });
});
```

> If you extend the shared `HEADER` const instead of using a local `gaugeHeader`,
> the existing golden-record tests in this file will now see the gauge keys in
> `agent_metadata` and their `countPopulatedFields` / golden assertions may shift.
> Prefer the **local `gaugeHeader`** shown above so the existing goldens stay
> untouched. Run the whole file and fix any incidental drift by extending the
> golden expectation to the new keys — never by weakening it.

### 5.1a `proxai_nest` — agentKv path regression (Vitest)

**File:** `src/agent-gateway/parsers/cursor/services/tests/cursor-agent-kv-turn.service.spec.ts`

The agentKv path calls `buildAgentMetadata(null, composerHeader, toolSummary)` with
**no 4th argument** (`cursor-agent-kv-turn.service.ts:246`), so the
`turnContextTokens` default of `null` applies. This regression test pins the
contract from the §3.3 note: agentKv records DO get the composer-level gauge
(through the shared `composerHeader`) but MUST NOT carry a per-turn
`turn_context_tokens` key. Reuse the existing `header()` builder — it takes a
`Partial<PinnedComposerHeader>`, and because the six gauge fields are optional
(§3.3a) the override compiles with no edit to `header()`:

```ts
it('carries the composer-level gauge but never a per-turn turn_context_tokens', () => {
  const rec = finalizeAgentKvTurn({
    turn: turn(),
    composerHeader: header({
      contextTokensUsed: 114724,
      contextTokenLimit: 200000,
      contextUsagePercent: 57,
      totalLinesAdded: 231,
      totalLinesRemoved: 88,
    }),
    chat: makeChat(),
    parentTurnId: null,
    firstCaptureId: 'cap-1',
    lastCaptureId: 'cap-1',
    lastCaptureWatermark: 100n,
    parserVersion: '1.0.0',
  });
  expect(rec).not.toBeNull();
  const meta = rec?.agentMetadata as Record<string, unknown>;
  // Composer-level gauge rides through the shared composerHeader.
  expect(meta.context_tokens_used).toBe(114724);
  expect(meta.context_token_limit).toBe(200000);
  expect(meta.context_usage_percent).toBe(57);
  expect(meta.total_lines_added).toBe(231);
  expect(meta.total_lines_removed).toBe(88);
  // agentKv shell turns have no per-turn user bubble → key never attached.
  expect('turn_context_tokens' in meta).toBe(false);
});
```

### 5.2 `proxai_nest` — pinComposer gauge-pinning test (Vitest)

**File:** `src/agent-gateway/parsers/cursor/services/tests/cursor-parse-chat.service.spec.ts`

**Required, not optional.** `pinComposer` is module-private but reachable through
`parseChat` — the existing spec already drives composer pinning end-to-end (see
the orphan test at spec lines 283-298, which uses inline `composerData:` rows +
two `userBubble(...)` rows to close exactly one turn). Add the `describe` block
below. It proves two things the §5.1 finalize-turn test cannot: (a) the pin
survives across the accumulator into the emitted record, and (b) latest-non-null
**wins even when the later snapshot is LOWER** (context compaction), the edge case
§2.3 calls out. Use the spec's existing `makeChat`, `makeChunk`, `makeService`,
`userBubble`, and `PARSER_VERSION` (no new builders needed); inline the
`composerData:` rows so they carry the gauge fields (the `composerRow` helper at
spec lines 41-60 does not):

```ts
describe('cursor pinComposer — context-size gauge (latest-non-null wins)', () => {
  function composerWithGauge(id: string, contextTokensUsed: number) {
    return {
      rowid: 1,
      key: `composerData:${id}`,
      value: JSON.stringify({
        _v: 13,
        composerId: id,
        status: 'completed',
        unifiedMode: 'agent',
        forceMode: 'edit',
        modelConfig: { modelName: 'claude-opus-4-7' },
        isAgentic: true,
        contextTokensUsed,
        contextTokenLimit: 200000,
        contextUsagePercent: 57,
      }),
    };
  }

  it('pins the latest composer snapshot even when it reports a LOWER value', async () => {
    const service = makeService();
    // Two composer rewrites for the same conversation: 120k then a lower 80k
    // (context compaction). The pinned gauge must reflect the LATEST (80k), not
    // a MAX (120k). Two userBubbles close one turn so a record is emitted.
    const chat = makeChat(
      makeChunk(
        [
          composerWithGauge('cmp-A', 120000),
          composerWithGauge('cmp-A', 80000),
          userBubble('cmp-A', 'u-1', 'first', 3),
          userBubble('cmp-A', 'u-2', 'closes', 4),
        ],
        'cap-1',
        0n,
        100n,
      ),
    );
    const result = await service.parseChat(null, chat, PARSER_VERSION);
    expect(result.records).toHaveLength(1);
    const meta = result.records[0].agentMetadata as Record<string, unknown>;
    expect(meta.context_tokens_used).toBe(80000); // latest snapshot, NOT max(120000)
    expect(meta.context_token_limit).toBe(200000);
    expect(meta.context_usage_percent).toBe(57);
  });
});
```

Run:

```bash
bun run test:unit src/agent-gateway/parsers/cursor/services/tests/cursor-parse-chat.service.spec.ts
```

> If `parseChat`'s turn-close behavior on the inline rows differs from the orphan
> test (e.g. the record set differs), adapt the bubble/composer set to mirror spec
> lines 283-298 exactly — but keep the assertion that `context_tokens_used` equals
> the **second** (lower) composer's value, which is the load-bearing check.

### 5.3 `proxai_nest` — usage extractors stay null (Vitest, regression guard)

The existing `extractors/tests/usage.spec.ts` already asserts all four extractors
return `{ value: null, confidence: 'authoritative' }`. **Leave it green and
unchanged** — it is the regression guard that the billed columns stay null. Do not
modify it.

### 5.4 `proxai_gateway` — keep-key trim test (Bun)

**File:** `proxai_gateway/src/sources/cursor/tests/trim.test.ts`

This file uses `import { expect, test } from 'bun:test'` and a local `parse()`
helper. Add:

```ts
test('trimCursorRowValue: bubbleId keeps the per-turn context-size gauge', () => {
  const value = JSON.stringify({
    _v: 3,
    type: 1,
    bubbleId: 'b1',
    text: 'do the thing',
    contextWindowStatusAtCreation: { tokensUsed: 114724, tokenLimit: 200000 },
    gitDiffs: [],
  });
  const trimmed = parse(trimCursorRowValue('bubbleId:c1:b1', value));
  expect(trimmed.contextWindowStatusAtCreation).toEqual({
    tokensUsed: 114724,
    tokenLimit: 200000,
  });
  expect(trimmed.gitDiffs).toBeUndefined(); // non-keep keys still dropped
});
```

> Also confirm the existing `trim.test.ts` "bubbleId keeps conversational and
> metadata keys, drops the rest" test still passes — it must, because the keep-key
> add only *preserves* one more field; it removes nothing.

---

## 6. Execution order & commands (IF reactivated)

Work P1 (nest) and P2 (gateway) independently — no ordering dependency, but do
both. P2 takes effect on new captures only; P1 + Phase 11 re-parse backfills the
composer-level gauge on existing Cursor ACRs.

### proxai_nest (P1)
1. `cursor.utils.ts` — type the new composer + bubble fields (§3.1).
2. `cursor-parse-chat.service.ts` — extend `pinComposer` (§3.2). **No
   `ACCUMULATOR_VERSION` bump.**
3. `cursor-finalize-turn.service.ts` — extend `PinnedComposerHeader`, thread the
   per-turn gauge, extend `buildAgentMetadata` (§3.3).
4. Tests (§5.1–§5.3).
5. Run:
   ```bash
   bun run typecheck
   bun run test:unit src/agent-gateway/parsers/cursor/services/tests/cursor-finalize-turn.service.spec.ts
   bun run test:unit src/agent-gateway/parsers/cursor/services/tests/cursor-parse-chat.service.spec.ts
   bun run test:unit src/agent-gateway/parsers/cursor/services/tests/cursor-agent-kv-turn.service.spec.ts
   bun run test:unit src/agent-gateway/parsers/cursor/extractors/tests/usage.spec.ts
   ```
   `bun run typecheck` is whole-project, so it catches any `PinnedComposerHeader`
   literal that would break — including ones the per-file test commands above do
   **not** run (e.g. `cursor-parser.service.spec.ts`,
   `cursor-migrate-accumulator.service.spec.ts`). With the optional-field
   declaration (§3.3a) none of them should break; if typecheck still reports a
   missing `contextTokensUsed`/`contextTokenLimit`/etc. on some literal, you made
   the fields required — re-check §3.3a, do not "fix" it by editing the literal.
   Do NOT run `bun run validate` while iterating.

### proxai_gateway (P2)
1. `src/sources/cursor/process-rows.ts` — add `contextWindowStatusAtCreation` to
   `CURSOR_BUBBLE_KEEP_KEYS` (§4).
2. Test (§5.4).
3. Run:
   ```bash
   bun run typecheck
   bun test src/sources/cursor/tests/trim.test.ts
   bun run lint
   ```

If a command fails, fix the cause — never silence it with a suppression or an
`any`.

---

## 7. Audit / self-check greps (before hand-back)

From the phase spec's orchestrator quick-check, plus the gauge-vs-flow guard:

```bash
# proxai_nest — extraction wired, billed columns untouched
grep -n "contextTokensUsed\|contextWindowStatusAtCreation\|context_tokens_used\|turn_context_tokens" \
  proxai_nest/src/agent-gateway/parsers/cursor/cursor.utils.ts \
  proxai_nest/src/agent-gateway/parsers/cursor/services/cursor-finalize-turn.service.ts \
  proxai_nest/src/agent-gateway/parsers/cursor/services/cursor-parse-chat.service.ts

# proxai_gateway — keep-key added
grep -n "contextWindowStatusAtCreation" proxai_gateway/src/sources/cursor/process-rows.ts

# GAUGE-VS-FLOW guard: the gauge must NEVER reach result.usage.input_tokens.
# The cursor result.usage block must still be hardcoded null.
grep -n "input_tokens: null" proxai_nest/src/agent-gateway/parsers/cursor/services/cursor-finalize-turn.service.ts
# And the gauge keys must NOT appear anywhere inside a result.usage assignment:
grep -n "usage" proxai_nest/src/agent-gateway/parsers/cursor/services/cursor-finalize-turn.service.ts | grep -i "context\|lines"  # → expect NO hits

# ACCUMULATOR_VERSION untouched
grep -n "ACCUMULATOR_VERSION = " proxai_nest/src/agent-gateway/parsers/cursor/services/cursor-parse-chat.service.ts  # → still 1

# declaredFields NOT changed for the gauge (it's JSONB, not a declared field)
grep -n "result.usage" proxai_nest/src/agent-gateway/parsers/parsers.versions.ts  # cursor block still omits the four billed columns
```

Expected: the gauge keys appear only in `cursor.utils.ts` (types),
`pinComposer`/`PinnedComposerHeader`, and `buildAgentMetadata` (agent_metadata
emit) — and **never** inside a `result.usage` object or a SUM. If you find a path
that adds any `context_*` / `turn_context_tokens` value into `inputTokens` or a
grand total, **stop and report it** — that is the gauge-vs-flow violation.

---

## 8. Hand-back report (send this to the orchestrator / verifier)

1. **Confirm the reactivation instruction.** State that the operator explicitly
   reactivated Phase 8 in the current prompt (this phase is otherwise DEFERRED).
2. **Files changed** (path + one-line description), for both repos.
3. **The source diffs** pasted verbatim: `cursor.utils.ts` (types),
   `cursor-parse-chat.service.ts` (`pinComposer`), `cursor-finalize-turn.service.ts`
   (`PinnedComposerHeader` + `buildAgentMetadata` + per-turn read),
   `process-rows.ts` (keep-key).
4. **Test results**: paste the green output of each §6 command + `bun run
   typecheck` (nest) and `bun run typecheck` (gateway).
5. **Confirm the four flagged DECISIONS** (§3.5) were implemented as written:
   Option A only (billed columns null); gauge in `agent_metadata` (no schema
   column, no `declaredFields` change); **no `ACCUMULATOR_VERSION` bump**; sparse
   "only-present-keys" emit.
6. **Confirm the gauge-vs-flow invariant**: no gauge value reaches
   `result.usage.input_tokens` or any SUM (cite the §7 greps).
7. **Note** that P2 (keep-key) is new-captures-only and P1 is Phase-11
   backfillable; the agentKv path gets the composer-level gauge but not the
   per-turn `turn_context_tokens`.
8. **Anything you could not do without an `any`/suppression** — name the type
   friction instead of working around it (e.g. if `record.agentMetadata` typing
   fights you in the spec, narrow via `as Record<string, unknown>` once with a
   comment, never `as any`).

---

## 9. Acceptance criteria (the verifier checks all)

Mirrors `../phase-08-cursor-local-collection.md` "Acceptance criteria", made
concrete:

- [ ] **Option A/B decision recorded** as DECISION §3.5 #1 (Option A only; B/C
      held).
- [ ] Cursor composer context fields (`contextTokensUsed`, `contextTokenLimit`,
      `contextUsagePercent`, `promptTokenBreakdown`, `totalLinesAdded`,
      `totalLinesRemoved`) surfaced in `agent_metadata`; the four billed columns
      (`input_tokens` / `output_tokens` / `cache_read_input_tokens` /
      `cache_creation_input_tokens`) **remain null**.
- [ ] Per-turn `contextWindowStatusAtCreation.tokensUsed` surfaced as
      `agent_metadata.turn_context_tokens` (P2; new captures), and the gateway
      keep-key preserves it through the bubble trim.
- [ ] **Gauge semantics honored**: no SUM into `inputTokens`; the multi-turn test
      proves per-turn values are NOT summed; conversation-level value is the
      latest non-null composer snapshot (latest-wins, not a computed MAX), proven
      by the lowered-value test.
- [ ] No `ACCUMULATOR_VERSION` bump; no schema/migration; no `declaredFields`
      change.
- [ ] All new/updated nest (Vitest) and gateway (Bun) tests are green;
      `typecheck` and `lint` pass; the existing usage-null regression spec stays
      green.
- [ ] No `any`, no suppression comments, no before/after references.

---

## 10. Out of scope (do NOT do these) + cross-phase dependencies

- **The Cursor server connector** — Team Admin API real-token path AND the
  personal-JWT $-overlay. **Descoped** (operator decision 2026-06-17,
  `../analysis/CURSOR_TOKEN_COLLECTION.md` §2/§4). It is the *only* source of real
  billed Cursor tokens, but it is team-admin-only and ToS-gray. Do not build it.
- **Option B (estimated `outputTokens` via tokenization)** and **Option C
  (context-as-input)** — held; not part of this plan. Do not ship either without a
  fresh operator decision (DECISION §3.5 #1).
- **A new reasoning-token / billed-token schema column** — locked SKIP
  (`../ROADMAP.md` "Decisions LOCKED" #1). The gauge is JSONB only.
- **Touching the Claude Code / Codex / Gemini parsers or the shared
  `build-scalar-spine.ts`** — Phase 8 is Cursor-only. `build-scalar-spine.ts` is
  agent-agnostic; it passes `agentMetadata` JSONB through unchanged (`:116,:183`)
  and needs no edit.
- **The billed-token columns** — they stay null under Option A. Do not estimate,
  do not copy the gauge in. The current "all-null billed" is a *billed-token* gap,
  not a *no-data* gap, and Option A keeps it truthful.

**Cross-phase dependencies:**
- **Phase 10** (Web KPI label + Cursor null display) is the *display* half — it
  ships the honest "not captured" Cursor view regardless of whether Phase 8 runs.
  If Phase 8 lands, Phase 10 (or a follow-up) can additionally render the
  `agent_metadata` context-size gauge. Phase 10 does NOT block on Phase 8.
- **Phase 11** (production backfill / re-parse) retroactively backfills the
  **composer-level** gauge (P1) onto existing Cursor ACRs, since `composerData`
  rows are already in S3. The **per-turn** gauge (P2) is new-captures-only and is
  NOT backfillable (the field was trimmed pre-upload on historical captures).
- **Follow-up docs when implemented:** refresh the `extractors/usage.ts` docstring
  and the `cursor.md` knowledge file to state that billed tokens are absent by
  design but the context-size + line metrics are now available in `agent_metadata`.
```
