# Phase 7 — Implementation Instructions (for the implementer model)

> **Audience:** the small/fast implementer model that will write the code.
> **Author:** orchestrator chat (source-verified against both repos on 2026-06-17).
> **Companion specs (already settled — do not re-open):**
> `../phase-07-claude-desktop-version-resolution.md`, `../ROADMAP.md`,
> `../analysis/VERIFICATION_FINDINGS.md` §11.2, `../analysis/IMPLEMENTATION_PLAN.md` Rank 7,
> and the already-shipped `./phase-01-implementation-instructions.md` (you depend on its gateway export).
>
> Everything you need is here. Every path/line/snippet below was read from the
> actual source on disk. **Follow it literally.** If line numbers have drifted,
> trust the *named symbol* (function/interface/const name), not the line number.
>
> **Repos this phase touches:** `proxai_nest` (required) + `proxai_gateway` (one
> recommended change — see the flagged decision in §3.5).

---

## 0. TL;DR — what you are doing

Claude **Desktop** currently produces **ZERO** AgentCallRecords. That is a structural
**bug**, not low volume. The gateway stamps a *prefixed* `agentSchemaVersion`
(`claude-desktop/v2`, or `claude-desktop/<cli-semver>`), but nest registers
`CLAUDE_DESKTOP` under the **plain** `semverScheme` with **no prefix strip**. `semver.valid('claude-desktop/v2')`
is `null`, so `resolveParserSet(...)` returns `null` and every Desktop chat is marked
`UNSUPPORTED_VERSION` **before any extractor runs**.

You will register `CLAUDE_DESKTOP` under a **prefix-stripping scheme** (mirroring the
existing `geminiScheme` that strips `antigravity/`), plus a tiny extra rule so the
`claude-desktop/v2` schema-marker sentinel resolves to the newest Claude Code parser.
Desktop already routes to `ClaudeCodeParserService` (a fall-through `case` in the
parser registry) and already shares the CC version-range array by reference — so once
the version resolves, Desktop produces ACRs through the **same** parser as Claude Code.

**Total surface:**

| Repo | File | Required? |
|---|---|---|
| `proxai_nest` | `src/agent-gateway/parsers/parsers.versions.ts` (new scheme + comment) | ✅ required |
| `proxai_nest` | `src/agent-gateway/parsers/tests/parsers.versions.spec.ts` (update + add) | ✅ required |
| `proxai_nest` | `src/agent-gateway/parsers/claude-code/services/tests/claude-code-parse-chat.service.spec.ts` (one Desktop ACR test) | ✅ required |
| `proxai_nest` | `ai/knowledge/agent-gateway/desktop-routing.md` (+ run the mapper) | ✅ required |
| `proxai_gateway` | `src/sources/claude-desktop/collect.ts` (Phase-1 union filter for Desktop) | ⚠️ recommended — see §3.5 DECISION |
| `proxai_gateway` | `src/sources/claude-desktop/tests/collect.test.ts` (if you do the collect change) | ⚠️ recommended |

There is **no schema change, no migration, no new module, no new queue, no new
metric**. The `CLAUDE_DESKTOP` enum, Prisma CHECK constraints, parser-registry case,
and version-range alias all already exist.

---

## 1. Hard rules (apply to BOTH repos — non-negotiable)

These are enforced by lint/CI and by human reviewers. Violating any one fails the phase.

- **No `any`.** Not `: any`, not `as any`, not `Promise<any>`, not `Record<string, any>`,
  not a generic default `= any`, not an implicit any. Use `unknown` + a type guard at
  boundaries. This holds in `.ts` **and** `.spec.ts` / `.test.ts` files. Both repos ban it.
  If a third-party type *forces* an any, **stop and report it** instead of inserting one.
- **No suppression comments.** No `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`,
  `eslint-disable`, `oxlint-disable`, `v8 ignore`. Fix the type — do not silence the tool.
- **No "before/after" references** in code, comments, or test names. Describe **current**
  behavior only. A test name says what the code does now
  (`it('resolves a prefixed claude-desktop/v2 version to the Claude Code parser set', ...)`),
  never "no longer 400s" / "used to be UNSUPPORTED". The knowledge doc may document the
  resolution mechanism (knowledge docs explain *why* the contract is shaped this way), but
  do not frame it as a changelog.
- **No hardcoded enum-string values.** Reference the `AgentAppName` members / const-objects,
  not bare string literals (the registry keys `CLAUDE_DESKTOP`, `CLAUDE_CODE` are already
  object keys — that is fine; the rule is about not minting `'CLAUDE_DESKTOP'` at a new call site).
- **Comments explain *why*, not *what*.** No decorative banners.
- **Package manager is `bun`** in both repos. Never `npm`/`pnpm`/`yarn`.
- **Do not run the full validate/build gate** while iterating. Run the **file-specific
  test** plus `typecheck`. Commands in §5.
- **Git:** do **not** commit, push, branch, or stage anything unless the operator
  explicitly tells you to. Make the edits and leave them in the working tree.

---

## 2. The mental model — READ THIS BEFORE WRITING CODE

### 2.1 The two-layer bug

There are two independent reasons Desktop produces no usable data. **Change 1 fixes the
first (the show-stopper); the §3.5 gateway change fixes the second.**

**Layer A — the version short-circuit (the show-stopper, fixed by Change 1).**
The gateway (`proxai_gateway/src/sources/claude-desktop/collect.ts:171-180`) stamps:

```
agentSchemaVersion = `claude-desktop/${first.agentVersion}`   // e.g. "claude-desktop/2.1.122"
   // or, when the embedded CLI's version can't be read off the transcript:
agentSchemaVersion = CLAUDE_DESKTOP_DEFAULT_AGENT_SCHEMA_VERSION  // "claude-desktop/v2"
```

Nest's `VERSION_SCHEMES.CLAUDE_DESKTOP` is the **plain** `semverScheme`
(`parsers.versions.ts:186`), whose matcher is `semver.valid(v) ? semver.satisfies(v, r) : false`.
Verified on the live `semver@7.8.0` in this repo:

```
semver.valid("claude-desktop/v2")        === null   → match false → UNSUPPORTED_VERSION
semver.valid("claude-desktop/2.1.122")   === null   → match false → UNSUPPORTED_VERSION
```

So **every** Desktop capture — sentinel or real-semver form — fails to resolve.
`parse-process-chat.service.ts:128-148` then marks the chat `UNSUPPORTED_VERSION` and
calls `failureWrite.writeUnsupportedVersion(...)`. **Zero ACRs.**

The fix mirrors `geminiScheme` (`parsers.versions.ts:163-178`), which strips `antigravity/`
before applying semver. After stripping `claude-desktop/`:

```
"claude-desktop/2.1.122" → "2.1.122" → semver.satisfies("2.1.122", ">=2.1.0 <2.2.0") === true   ✅ resolves
"claude-desktop/3.0.0"   → "3.0.0"   → satisfies(">=2.1.0 <2.2.0")               === false  → UNSUPPORTED (correct gating preserved)
"claude-desktop/v2"      → "v2"      → semver.valid("v2") === null               → would be UNSUPPORTED ← problem
```

**The `v2` wrinkle (verified):** `semver.valid("v2")` is `null` — `v2` is a *gateway
capture-schema marker*, not a CLI semver. A pure gemini-mirror would leave `claude-desktop/v2`
UNSUPPORTED, and `claude-desktop/v2` is the **dominant real-world stamp** (the gateway test
`proxai_gateway/.../tests/collect.test.ts:181` asserts batches default to exactly
`claude-desktop/v2` whenever the transcript carries no readable CLI version). The phase's
acceptance criteria explicitly require `claude-desktop/v2` to resolve. So the scheme must
treat the `v2` sentinel as "unknown CLI version → route to the newest registered CC parser"
(Desktop embeds the CC CLI). See the flagged **DECISION** in §3.1.

**Layer B — Desktop's own collector still drops usage-bearing `tool_use` records (the §3.5 gateway change).**
Desktop has its **own** collector (`claude-desktop/collect.ts`), separate from Claude Code's.
It filters with the bare display predicate `isDialogueRecord` (`collect.ts:121`), exactly the
predicate Phase 1 split apart for Claude Code. Phase 1 fixed `claude-code/collect.ts` by OR-ing
in `isUsageBearingAssistantRecord`; **that fix did NOT propagate to Desktop's collector** (Phase 1
§3.5 explicitly excludes `claude-desktop/`). So the moment Layer A resolves and Desktop lights up,
Desktop will under-count tokens by ~75% — the *exact* F1 shape Phase 1 eliminated for CC.
§3.5 applies the same one-line union to Desktop's collector.

### 2.2 What Desktop inherits — the precise map

Desktop routes to `ClaudeCodeParserService`
(`src/agent-gateway/parsers/services/parser-registry.service.ts:119-129`,
fall-through `case 'CLAUDE_CODE': case 'CLAUDE_DESKTOP': return this.claudeCode;`).
Therefore:

| Phase | Where it lives | Inherited by Desktop? |
|---|---|---|
| **P1 nest fold** (`claude-code/extractors/usage.ts` — `inputTokens = input + cache_creation`) | shared CC extractor | ✅ automatically — same extractor |
| **P1 gateway filter** (`claude-code/collect.ts` union with `isUsageBearingAssistantRecord`) | CC's **own** collector | ❌ NOT inherited — Desktop has a separate collector (§3.5 fixes this) |
| **P4 upsert shrink-guard** (`parse/services/parse-batch-upsert.service.ts`) | shared agent-agnostic spine | ✅ automatically |
| **P5 idle-flush orphan-drop** (`claude-code/services/claude-code-parse-chat.service.ts`) | shared CC parser | ✅ automatically |

This is **why the sequencing gate exists**: Phases 1, 4, 5 must be merged before Phase 7,
otherwise lighting up Desktop exposes a known-undercounting / corruption path. (Per ROADMAP
status board, Phase 1 is 🟢 VERIFIED; confirm 1/4/5 are ✅ before this lands — see §8.)

### 2.3 Worked example (real token math) — a 3-call Desktop turn

A Desktop turn = `user prompt + 2 tool_use assistant calls (each separately billed) + final text`.
Anthropic reports `usage` **per request**. Concrete numbers:

| Record | input_tokens | output_tokens | cache_creation | cache_read |
|---|---|---|---|---|
| assistant tool_use #1 | 100 | 20 | 50 | 10 |
| assistant tool_use #2 | 200 | 30 | 0 | 400 |
| assistant final text | 5 | 80 | 0 | 600 |

`aggregateUsage` (shared CC summer, `claude-code.utils.ts:382-437`) sums across the assistant
records: `input=305, output=130, cache_creation=50, cache_read=1010`. The Phase-1 fold in the
CC `inputTokensExtractor` then stores **fresh input** = `305 + 50 = 355`; `cacheCreationInputTokens=50`
(raw, kept, a non-additive subset); `cacheReadInputTokens=1010`; `outputTokens=130`.

- **With Change 1 only (no §3.5):** Desktop's collector drops tool_use #1 and #2 *before upload* →
  only the final-text call reaches the backend → stored `inputTokens=5` instead of `355`. A ~98%
  under-count on this turn. **This is why §3.5 matters.**
- **With Change 1 + §3.5:** all three calls reach the backend → the full `355 / 130 / 50 / 1010`
  is stored. Correct.
- **Without Change 1 (today):** the chat is `UNSUPPORTED_VERSION` → **zero** ACRs; none of the
  above happens.

---

## 3. CHANGE 1 — `proxai_nest`: register CLAUDE_DESKTOP under a prefix-stripping scheme

**File:** `proxai_nest/src/agent-gateway/parsers/parsers.versions.ts`

### 3.1 Add the `claudeDesktopScheme` (right after `geminiScheme`)

The `geminiScheme` block ends at line 178 (the closing `};` of the `geminiScheme` const).
Insert the following **immediately after it**, before the `export const VERSION_SCHEMES`
declaration. It reuses the file's existing `semver` import (line 24) and the `VersionScheme`
type (line 36). No new imports.

> **DECISION (flagged for the reviewer) — how the `claude-desktop/v2` sentinel resolves.**
> The recommended design (below) is a dedicated `prefixed-semver` scheme that (a) strips
> `claude-desktop/`, (b) returns `true` for the **exact** `v2` schema-marker sentinel so the
> unknown-CLI case routes to the newest registered CC range, and (c) otherwise applies the
> normal `semver.valid → satisfies` gate. This is the **lowest-blast-radius** option: nest-only,
> no gateway version-contract change, mirrors `geminiScheme`, and satisfies the literal
> acceptance criterion that `claude-desktop/v2` resolves while still gating real semvers
> (`claude-desktop/3.0.0` stays UNSUPPORTED). **Alternatives considered and rejected:**
> *(B)* a pure gemini-mirror with no sentinel case — rejected because `claude-desktop/v2` (the
> dominant stamp) would stay UNSUPPORTED, failing the acceptance criterion and leaving most
> Desktop captures dark; *(C)* changing the gateway's `CLAUDE_DESKTOP_DEFAULT_AGENT_SCHEMA_VERSION`
> to a fabricated semver — rejected because it invents a CLI version the gateway genuinely does
> not know, and the spec says the gateway needs no version-contract change when nest strips the
> prefix. Do not change the sentinel semantics without the reviewer's say-so.

Add this:

```ts
/**
 * Claude Desktop embeds the Claude Code CLI binary and writes byte-identical
 * JSONL, so the on-disk `version` field is the embedded CLI's semver. The
 * gateway namespaces `agent_schema_version` as the `claude-desktop/` prefix
 * followed by that value (`claude-desktop/2.1.122`), or the schema-marker
 * sentinel `claude-desktop/v2` when the embedded CLI's version could not be
 * read off the transcript (gateway `CLAUDE_DESKTOP_DEFAULT_AGENT_SCHEMA_VERSION`).
 *
 * The prefix is stripped here so a known CLI semver matches the SAME ranges as
 * Claude Code (the range array is shared by reference) and is gated identically
 * — `claude-desktop/3.0.0` falls to UNSUPPORTED_VERSION exactly as a bare
 * `3.0.0` would for CC. The `v2` sentinel carries no CLI semver; because
 * Desktop IS the CC CLI, it resolves to the newest registered CC parser
 * instead of being lost to UNSUPPORTED_VERSION. Range expressions stay written
 * prefix-free (e.g. `>=2.1.0 <2.2.0`), identical to the CC/Codex entries.
 */
const CLAUDE_DESKTOP_SCHEMA_PREFIX = 'claude-desktop/';

/**
 * Cross-repo contract: the gateway stamps `claude-desktop/<this>` as the
 * default when no CLI semver is available. Mirror of
 * `proxai_gateway/src/sources/claude-desktop/claude-desktop.constants.ts`
 * (`CLAUDE_DESKTOP_DEFAULT_AGENT_SCHEMA_VERSION = 'claude-desktop/v2'`). It is
 * a capture-schema marker, NOT a CLI semver, so it cannot satisfy a semver
 * range and is matched explicitly.
 */
const CLAUDE_DESKTOP_VERSION_SENTINEL = 'v2';

function stripClaudeDesktopPrefix(incoming: string): string | null {
  if (!incoming.startsWith(CLAUDE_DESKTOP_SCHEMA_PREFIX)) return null;
  const rest = incoming.slice(CLAUDE_DESKTOP_SCHEMA_PREFIX.length);
  return rest.length > 0 ? rest : null;
}

const claudeDesktopScheme: VersionScheme = {
  kind: 'prefixed-semver',
  match: (incoming, range) => {
    const version = stripClaudeDesktopPrefix(incoming);
    if (version === null) return false;
    // Unknown-CLI schema marker → Desktop embeds the CC CLI, so route to
    // whichever range matched first (resolution is newest-first). Returning
    // true here makes the dominant real-world Desktop stamp resolve to the
    // newest CC parser instead of UNSUPPORTED_VERSION.
    if (version === CLAUDE_DESKTOP_VERSION_SENTINEL) return true;
    return semver.valid(version) ? semver.satisfies(version, range) : false;
  },
};
```

### 3.2 Point `VERSION_SCHEMES.CLAUDE_DESKTOP` at the new scheme + fix the stale comment

Find this block (currently `parsers.versions.ts:180-190`):

```ts
export const VERSION_SCHEMES: Record<AgentAppName, VersionScheme> = {
  CLAUDE_CODE: semverScheme,
  // CLAUDE_DESKTOP embeds the Claude Code CLI binary and stamps the embedded
  // CLI's semver into every JSONL event's `version` field — NOT the Desktop
  // app's own version (1.x.x at the time of writing). So Desktop uses the
  // same scheme as CC.
  CLAUDE_DESKTOP: semverScheme,
  CURSOR: cursorScheme,
  CODEX: semverScheme,
  gemini: geminiScheme,
};
```

Replace with:

```ts
export const VERSION_SCHEMES: Record<AgentAppName, VersionScheme> = {
  CLAUDE_CODE: semverScheme,
  // CLAUDE_DESKTOP embeds the Claude Code CLI binary and stamps the embedded
  // CLI's semver into every JSONL event's `version` field — NOT the Desktop
  // app's own version. The gateway namespaces that value as
  // `claude-desktop/<cli-semver>` (or the `claude-desktop/v2` schema-marker
  // sentinel when the CLI semver is unknown), so Desktop resolves through the
  // prefix-stripping `claudeDesktopScheme` — NOT the bare semver scheme —
  // against the shared CC version ranges.
  CLAUDE_DESKTOP: claudeDesktopScheme,
  CURSOR: cursorScheme,
  CODEX: semverScheme,
  gemini: geminiScheme,
};
```

That is the **entire** required source change to `parsers.versions.ts`. The
`KNOWN_AGENT_SCHEMA_VERSIONS.CLAUDE_DESKTOP` entry stays a **by-reference alias** of
`CLAUDE_CODE_VERSION_RANGES` (`parsers.versions.ts:295`) — **do NOT touch it.** Both the
range-array alias and the parser-registry fall-through case are already correct; only the
*version-string scheme* was wrong.

### 3.3 Why resolution now works (trace it)

`resolveParserSet('CLAUDE_DESKTOP', incoming)` (`parsers.versions.ts:705-725`) iterates the
non-deprecated ranges in `KNOWN_AGENT_SCHEMA_VERSIONS.CLAUDE_DESKTOP` (= the shared CC array,
one entry: `range: '>=2.1.0 <2.2.0'`, `parserSet: 'claude-code/v1'`) and calls
`scheme.match(incoming, reg.range)`:

| `incoming` | stripped | `match` result | resolves to |
|---|---|---|---|
| `claude-desktop/v2` | `v2` | sentinel → `true` | `claude-code/v1` ✅ |
| `claude-desktop/2.1.92` | `2.1.92` | `satisfies(">=2.1.0 <2.2.0")` → `true` | `claude-code/v1` ✅ |
| `claude-desktop/3.0.0` | `3.0.0` | `satisfies` → `false` | `null` → UNSUPPORTED (correct gating) |
| `claude-desktop/1.2.3` | `1.2.3` | `satisfies` → `false` | `null` → UNSUPPORTED (old embedded CLI, correctly gated) |
| `2.1.92` (no prefix) | — | `strip` → `null` → `false` | `null` → UNSUPPORTED (prefix now mandatory) |
| `claude-desktop/garbage` | `garbage` | `semver.valid` → `null` → `false` | `null` → UNSUPPORTED |

### 3.4 Do NOT touch these (and why)

- **`KNOWN_AGENT_SCHEMA_VERSIONS` / `CLAUDE_CODE_VERSION_RANGES`** — the range array stays
  shared by reference (`:295`). The reference-identity test at
  `parsers.versions.spec.ts:389-393` guards this; keep it green.
- **`src/agent-gateway/parsers/services/parser-registry.service.ts`** — the `CLAUDE_DESKTOP`
  → `claudeCode` fall-through case (`:119-129`) is already correct. No change.
- **`agent-gateway.types.ts`** — `AGENT_TO_SOURCE_APP` / `SOURCE_APP_TO_AGENT` already map
  `claude-desktop ↔ CLAUDE_DESKTOP` (`:59-73`). No change.
- **`build-scalar-spine.ts`, `claude-code/extractors/usage.ts`, `aggregateUsage`** — agent-agnostic
  / shared CC code already carrying Phase 1. No change.
- **`semverScheme`** — leave it exactly as-is; only `CLAUDE_DESKTOP`'s entry moves off it.

### 3.5 CHANGE 5 (gateway) — apply the Phase-1 union filter to Desktop's collector

> **DECISION (flagged for the reviewer) — REQUIRED for the phase's stated intent; the phase
> spec's literal "Change spec → proxai_gateway: no change if nest strips the existing prefix"
> is a stale-spec gap.** The spec's own data-refresh note says Desktop resolves "with the
> Phase-1 fix already applied so they don't under-count," and §11.2 says Desktop "INHERITS F1
> by routing." That is only **half** true: Desktop inherits the *nest* fold (shared extractor)
> but NOT the *gateway* usage-preservation, because `claude-desktop/collect.ts` is a separate
> collector that still filters with the bare `isDialogueRecord` (`collect.ts:121`). Lighting up
> Layer A (Change 1) without this change reproduces the exact ~75% F1 under-count for Desktop —
> the very thing the sequencing gate exists to prevent. **Recommendation: include this change.**
> It is a one-line union, identical in spirit to Phase 1's CC change, and it depends on Phase 1's
> already-shipped export `isUsageBearingAssistantRecord` from `sources/claude-code`.
> If the orchestrator explicitly wants a "version-resolution-only" Phase 7, this change can be
> deferred to a follow-up — but **say so in the hand-back**, because shipping Change 1 alone
> means Desktop ACRs under-count from day one.

**File:** `proxai_gateway/src/sources/claude-desktop/collect.ts`

**(a)** Extend the import at `collect.ts:27`:

```ts
import { isDialogueRecord } from 'sources/claude-code';
```

to:

```ts
import { isDialogueRecord, isUsageBearingAssistantRecord } from 'sources/claude-code';
```

> `isUsageBearingAssistantRecord` is exported from `sources/claude-code/collect.ts` and surfaced
> through the `sources/claude-code` barrel (`index.ts` does `export * from '.../collect.ts'`) by
> Phase 1. If your checkout does not yet have it, **stop** — Phase 7 depends on Phase 1 being
> merged; do not re-implement the predicate here.

**(b)** Change the filter condition at `collect.ts:121`. Find:

```ts
        const parsed = JSON.parse(line);
        if (parsed.isReplay === true || !isDialogueRecord(parsed)) {
          continue;
        }
```

Replace with:

```ts
        const parsed = JSON.parse(line);
        // Keep telemetry-bearing assistant records (tool_use steps carrying
        // per-call `usage`) alongside the display-filtered dialogue records,
        // so the backend's aggregateUsage sums the full agentic loop instead
        // of only the final text record. Mirrors the Claude Code collector's
        // union; Desktop embeds the same CLI and routes to the same parser.
        if (
          parsed.isReplay === true ||
          !(isDialogueRecord(parsed) || isUsageBearingAssistantRecord(parsed))
        ) {
          continue;
        }
```

That is the entire gateway source change. The downstream metadata merge, the
`session_id → desktopSessionId` rename, the `agentSchemaVersion` derivation from
`keptLines[0]`, the slice/redaction/cursor logic are all untouched — the union only **adds**
records, and `keptLines[0]` (the leading `user` record) is unchanged, so version stamping does
not regress.

**Do NOT touch `isDialogueRecord` in `claude-code/collect.ts`** (it is shared) and **do NOT**
touch any other gateway file.

---

## 4. Tests

### 4.1 `proxai_nest` — `parsers.versions.spec.ts` (REQUIRED — the load-bearing proof)

**File:** `proxai_nest/src/agent-gateway/parsers/tests/parsers.versions.spec.ts` (Vitest).

Three of the existing `CLAUDE_DESKTOP` tests assume the bare semver scheme and will break /
become inaccurate. Update them, then add a dedicated scheme-matcher block.

**(a) Update the existing in-range resolution test** (currently `:162-168`). It uses the **bare**
`'2.1.92'`, which no longer resolves (prefix is now mandatory). Change the Desktop input to the
prefixed form; keep the CC input bare:

```ts
  it('returns claude-code/v1 for CLAUDE_DESKTOP on a prefixed in-range CC schema version', () => {
    const desktop = resolveParserSet('CLAUDE_DESKTOP', 'claude-desktop/2.1.92');
    const cc = resolveParserSet('CLAUDE_CODE', '2.1.92');
    expect(desktop?.parserSet).toBe('claude-code/v1');
    expect(desktop?.parserSet).toBe(cc?.parserSet);
    expect(desktop?.declaredFields).toBe(cc?.declaredFields); // same array reference
  });
```

**(b) Replace the existing out-of-range test** (currently `:170-174`, which passes bare values
that now fail for the *prefix* reason, masking the gating intent) with prefixed out-of-range
cases plus an explicit bare-prefix-required case:

```ts
  it('returns null for prefixed CLAUDE_DESKTOP versions outside the CC range', () => {
    expect(resolveParserSet('CLAUDE_DESKTOP', 'claude-desktop/3.0.0')).toBeNull();
    expect(resolveParserSet('CLAUDE_DESKTOP', 'claude-desktop/1.2.3')).toBeNull();
    expect(resolveParserSet('CLAUDE_DESKTOP', 'claude-desktop/garbage')).toBeNull();
  });

  it('requires the claude-desktop/ prefix — a bare semver does not resolve for CLAUDE_DESKTOP', () => {
    expect(resolveParserSet('CLAUDE_DESKTOP', '2.1.92')).toBeNull();
    expect(resolveParserSet('CLAUDE_DESKTOP', 'v2')).toBeNull();
    expect(resolveParserSet('CLAUDE_DESKTOP', '')).toBeNull();
  });

  it('resolves the prefixed claude-desktop/v2 schema sentinel to the Claude Code parser set', () => {
    const r = resolveParserSet('CLAUDE_DESKTOP', 'claude-desktop/v2');
    expect(r?.parserSet).toBe('claude-code/v1');
    expect(r?.declaredFields).toContain('result.usage.input_tokens');
  });
```

**(c) Rewrite the scheme-identity test** (currently `:395-399`,
`'VERSION_SCHEMES.CLAUDE_DESKTOP uses the same scheme as CLAUDE_CODE'` with
`expect(VERSION_SCHEMES.CLAUDE_DESKTOP).toBe(VERSION_SCHEMES.CLAUDE_CODE);`). That assertion is
now false by design. Replace that single `it(...)` with a matcher-behavior test:

```ts
  it('VERSION_SCHEMES.CLAUDE_DESKTOP strips the claude-desktop/ prefix before applying the CC range', () => {
    const m = VERSION_SCHEMES.CLAUDE_DESKTOP.match;
    // Prefixed real semver gated against the CC range.
    expect(m('claude-desktop/2.1.92', '>=2.1.0 <2.2.0')).toBe(true);
    expect(m('claude-desktop/3.0.0', '>=2.1.0 <2.2.0')).toBe(false);
    // The v2 schema sentinel routes through regardless of the range (unknown CLI → newest CC parser).
    expect(m('claude-desktop/v2', '>=2.1.0 <2.2.0')).toBe(true);
    // The prefix is mandatory; a bare semver never matches.
    expect(m('2.1.92', '>=2.1.0 <2.2.0')).toBe(false);
    expect(m('claude-desktop/garbage', '>=2.1.0 <2.2.0')).toBe(false);
    expect(m('claude-desktop/', '>=2.1.0 <2.2.0')).toBe(false);
    // It is NOT the same object as the bare CC scheme anymore.
    expect(VERSION_SCHEMES.CLAUDE_DESKTOP).not.toBe(VERSION_SCHEMES.CLAUDE_CODE);
  });
```

**(d) KEEP unchanged** the range-array reference-identity test (`:389-393`,
`KNOWN_AGENT_SCHEMA_VERSIONS.CLAUDE_DESKTOP === ...CLAUDE_CODE`) and the frozen test
(`:408-413`) — both still hold (you did not touch the ranges). If the surrounding describe-block
header (`:378`) says "shares CC version-range array by reference," that is still true; only the
*scheme* diverged. Leave that header.

> Do **not** weaken or delete the range-alias / frozen tests. Only the two version-string
> assertions that depended on the scheme being identical needed updating.

### 4.2 `proxai_nest` — Desktop ACR-producing test (REQUIRED)

**File:** `proxai_nest/src/agent-gateway/parsers/claude-code/services/tests/claude-code-parse-chat.service.spec.ts`

The spec above (§4.1) proves the *version resolves*. This proves the *routed parser produces a
Desktop ACR with the inherited Phase-1 token handling*. Use the **same harness this spec already
uses**: the top-level `makeService()`, `makeChat([...])`, and
`makeChunk(captureId, watermarkEnd, lines: object[])` helpers, where `makeChunk` serializes the
`lines` array to plain UTF-8 JSONL (`lines.map(JSON.stringify).join('\n')`) — there is **no**
zstd compression on the in-bundle chunks (zstd applies only to the S3-replay path, not to
`ChatBundle` chunks). Mirror the existing CLAUDE_DESKTOP propagation test at spec line ~1292,
which already constructs a `user{promptId:'p-1'}` + a boundary `user{promptId:'p-2'}` so the
`p-1` turn finalizes; you extend it with the two usage-bearing assistant records.

**Two load-bearing facts you MUST honor or the test fails:**

1. **A turn finalizes only when a NEW `promptId` boundary arrives** (or via idle-flush).
   `parseChat` BUFFERS while a single `promptId` is open and emits **zero** records (proven by
   the existing "emits no records on cold-start with a single open turn" test at spec line ~214).
   You therefore need a trailing boundary `user{promptId:'p-2'}` record so `p-1` finalizes. The
   user record carries the `promptId`; the assistant records carry **no** `promptId` (they link
   via `parentUuid`) and must all share the **same** `p-1` turn — assistant records under a
   different `promptId` would land in a different turn and not be summed by `aggregateUsage`.
2. **Usage extraction is gated by `matchesSupports`**, which calls
   `VERSION_SCHEMES[ctx.agent].match(chat.lastAgentSchemaVersion, extractor.supports)`. So you
   must set `chat.lastAgentSchemaVersion = 'claude-desktop/v2'` (a **prefixed** value). With
   Change 1 applied, `claudeDesktopScheme` accepts the `v2` sentinel and the CC usage extractors
   run, yielding non-null usage. If you left the `makeChat` default bare `'2.1.92'`, the prefix
   strip returns null and **every usage extractor is skipped → `input_tokens` null** and the
   test fails. This test depends on Change 1 (§3.2) — write/run it **after** that edit.

```ts
  it('produces a CLAUDE_DESKTOP ACR with the Phase-1-folded summed usage via the shared CC parser', async () => {
    const desktopService = makeService();
    const chat = makeChat([
      makeChunk('cap-1', 100n, [
        {
          type: 'user',
          uuid: 'u-1',
          sessionId: 'sess-1',
          version: '2.1.92',
          promptId: 'p-1',
          timestamp: '2026-04-01T00:00:00Z',
          message: { role: 'user', content: 'read foo' },
        },
        // Assistant tool_use call — NO promptId; carries per-call usage.
        {
          type: 'assistant',
          uuid: 'a-1',
          parentUuid: 'u-1',
          sessionId: 'sess-1',
          timestamp: '2026-04-01T00:00:01Z',
          message: {
            model: 'claude-sonnet-4-5',
            content: [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: { path: 'foo' } }],
            usage: {
              input_tokens: 100,
              output_tokens: 20,
              cache_creation_input_tokens: 50,
              cache_read_input_tokens: 10,
            },
          },
        },
        // Final assistant text — NO promptId; terminal text + stop_reason + usage.
        {
          type: 'assistant',
          uuid: 'a-2',
          parentUuid: 'a-1',
          sessionId: 'sess-1',
          timestamp: '2026-04-01T00:00:02Z',
          message: {
            model: 'claude-sonnet-4-5',
            content: [{ type: 'text', text: 'done' }],
            stop_reason: 'end_turn',
            usage: {
              input_tokens: 5,
              output_tokens: 80,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 600,
            },
          },
        },
        // Boundary record (new promptId 'p-2') so 'p-1' finalizes instead of buffering.
        {
          type: 'user',
          uuid: 'u-2',
          sessionId: 'sess-1',
          version: '2.1.92',
          promptId: 'p-2',
          timestamp: '2026-04-01T00:00:10Z',
          message: { role: 'user', content: 'next' },
        },
      ]),
    ]);
    chat.agent = 'CLAUDE_DESKTOP'; // routes to ClaudeCodeParserService via the registry fall-through
    chat.lastAgentSchemaVersion = 'claude-desktop/v2'; // the gateway's default Desktop stamp

    const result = await desktopService.parseChat(null, chat, '1.0.0');
    // Only the p-1 turn finalizes (p-2 stays open). One ACR carrying the SUMMED
    // loop usage with the Phase-1 fold (input 105 raw + cache_creation 50 = 155).
    expect(result.records).toHaveLength(1);
    const usage = result.records[0].result.usage;
    expect(usage?.input_tokens).toBe(155); // (100+5) raw input + (50+0) cache_creation
    expect(usage?.output_tokens).toBe(100); // 20 + 80
    expect(usage?.cache_creation_input_tokens).toBe(50); // raw, kept (non-additive subset)
    expect(usage?.cache_read_input_tokens).toBe(610); // 10 + 600
    // The agent lives top-level and on the capture stamp — NOT on chatStamp
    // (chatStamp = { chat_id, agent_id, chat_title, created_at_utc }).
    expect(result.records[0].agent).toBe('CLAUDE_DESKTOP');
    expect(result.records[0].capture.agent).toBe('CLAUDE_DESKTOP');
  });
```

> **Why this test is meaningful:** it pins that a `CLAUDE_DESKTOP` bundle with the
> `claude-desktop/v2` stamp (a) routes through the CC parser and (b) yields non-null usage —
> which only happens because Change 1 routes `CLAUDE_DESKTOP` through `claudeDesktopScheme` so
> `matchesSupports` accepts the `v2` sentinel and applies the CC extractors with the Phase-1
> fold. The parser does **not** ignore the agent/version: drop Change 1 (or use the old
> `semverScheme`) and every usage extractor is skipped, leaving `input_tokens` null. The version
> short-circuit itself lives in `parse-process-chat.service.ts`, proven by §4.1; this proves the
> downstream parse and reaffirms the §5 ordering (edit `parsers.versions.ts` before writing/
> running this test). Read the existing usage-bearing turn fixture (spec lines ~580-655) for the
> exact assistant-record shape before writing; do not invent helper APIs.

### 4.3 `proxai_gateway` — Desktop collector union test (only if you did §3.5)

**File:** `proxai_gateway/src/sources/claude-desktop/tests/collect.test.ts` (`bun:test`).

This file already imports the helpers you need (`collectClaudeDesktopFile`,
`CLAUDE_DESKTOP_DEFAULT_AGENT_SCHEMA_VERSION`, `nextPendingBatch`, `zstdDecompressSync`,
`requireDefined`, `mkdtemp`, `writeFile`, `statFile`, `rmRecursive`, `tmpdir`, `join`,
`openInMemoryBufferDb`). Add a test that proves a `tool_use` assistant record carrying `usage`
survives into the uploaded body. Mirror the existing
`'correlates dialogue records with CLI transcripts and merges metadata'` test's setup:

```ts
  test('keeps usage-bearing tool_use assistant records so the full Desktop loop reaches the backend', async () => {
    const db = openInMemoryBufferDb();
    const testDir = await mkdtemp(join(tmpdir(), 'proxai-test-claude-desktop-'));
    const tempFile = join(testDir, 'audit.jsonl');

    const auditContent =
      [
        JSON.stringify({
          type: 'user',
          uuid: 'u-1',
          session_id: 'sess-1',
          message: { role: 'user', content: 'read foo' },
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            id: 'msg-tool',
            content: [{ type: 'tool_use', id: 'toolu_desktop', name: 'Read' }],
            usage: { input_tokens: 3, output_tokens: 4 },
          },
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            id: 'msg-text',
            content: [{ type: 'text', text: 'done' }],
            usage: { input_tokens: 5, output_tokens: 6 },
          },
        }),
        '',
      ].join('\n') + '\n';
    await writeFile(tempFile, auditContent);

    const stat = await statFile(tempFile);
    if (!stat.exists) throw new Error(`Test file not found: ${tempFile}`);
    const file: DiscoveredClaudeDesktopFile = {
      sourcePath: tempFile,
      sourcePathHash: 'hash-desktop-usage',
      inode: Number(stat.inode),
      sizeBytes: stat.size,
      lastModifiedMs: Date.now(),
    };

    const res = await collectClaudeDesktopFile(file, {
      buffer: db,
      maxDecompressedBytes: 10_000,
    });
    expect(res.errors).toEqual([]);
    expect(res.capturedBatches).toBe(1);

    const batch = requireDefined(nextPendingBatch(db));
    const body = new TextDecoder().decode(zstdDecompressSync(batch.body));
    // The intermediate tool_use call and its per-call usage survive to the body.
    expect(body).toContain('toolu_desktop');
    expect(body).toContain('"input_tokens":3');
    expect(body).toContain('"output_tokens":4');
    // The final text record is present too (regression guard for normal records).
    expect(body).toContain('"input_tokens":5');

    db.close();
    await rmRecursive(testDir);
  });
```

> `DiscoveredClaudeDesktopFile` is already imported at the top of that file. The existing
> `'correlates dialogue records...'` and `'bumps the schema version'` tests must stay green — the
> union only adds records, never removes; confirm they still pass.
>
> The `body.toContain('"input_tokens":3')` assertions rely on Desktop's redaction NOT rewriting
> numeric `usage` values. The existing `'bumps the schema version'` test already asserts on the
> decompressed body content, so the redaction pass is known to preserve the JSON shape — but read
> that test first and confirm the body it asserts on is post-redaction. If your checkout's
> redaction does scrub numbers (it should not — `usage` integers are not PII), assert on the
> presence of the `toolu_desktop` tool id and the assistant record count instead of the literal
> token substrings, rather than weakening the test.

### 4.4 `proxai_nest` — update the knowledge doc + run the mapper (REQUIRED)

**File:** `proxai_nest/ai/knowledge/agent-gateway/desktop-routing.md` (the **source**; never edit
`.claude/knowledge/...`, it is generated).

The doc currently documents the shared-parser routing as fully functional and is silent on the
fact that the version-scheme mismatch was sending every Desktop chat to `UNSUPPORTED_VERSION`.
Add a short section (place it right after the `## Where the routing lives` table, before
`## Pre-emptive parser-fork trigger`) that records the version-resolution contract. Suggested
body (adjust prose, keep it factual and *why*-focused — not a changelog):

```md
## Version resolution — the `claude-desktop/` prefix contract

The gateway stamps `agent_schema_version` as `claude-desktop/<cli-semver>`
(`proxai_gateway/.../claude-desktop/collect.ts`), or the schema-marker sentinel
`claude-desktop/v2` (`CLAUDE_DESKTOP_DEFAULT_AGENT_SCHEMA_VERSION`) when the embedded CLI's
version cannot be read off the transcript. `CLAUDE_DESKTOP` therefore resolves through a
prefix-stripping `claudeDesktopScheme` (`parsers.versions.ts`), mirroring `geminiScheme`'s
`antigravity/` strip — NOT the bare `semverScheme`. A bare or wrongly-prefixed value (or any
non-`claude-desktop/` scheme that forgot the strip) makes `semver.valid(...)` null, which routes
every Desktop chat to `UNSUPPORTED_VERSION` at `parse-process-chat.service.ts` before any
extractor runs — i.e. zero ACRs. The `v2` sentinel carries no CLI semver, so it resolves to the
newest registered CC range (Desktop embeds the CC CLI); a known CLI semver is gated normally
(`claude-desktop/3.0.0` falls to UNSUPPORTED exactly as a bare `3.0.0` would for CC).

The routing anchors above resolve Desktop captures, but only AFTER the version scheme strips
the `claude-desktop/` prefix. The range-array alias and the parser-registry fall-through case
are necessary but not sufficient on their own — the prefix-stripping version-string scheme is
the anchor that lets resolution even begin.
```

Also fix the routing-anchor table **and its lead-in count**. The existing doc opens the
`## Where the routing lives` section with `Four code anchors. Touch all four when extending or
forking:` (currently `desktop-routing.md:9`) above a 4-row table. Because you are adding a
fifth anchor (the version-string scheme), update that lead-in line to
`Five code anchors. Touch all five when extending or forking:` and append this row to the table:

```md
| Version-string scheme (prefix strip) | `src/agent-gateway/parsers/parsers.versions.ts` | (the `claudeDesktopScheme` block + VERSION_SCHEMES) |
```

Make sure the new section's prose (above) and the table's anchor count reconcile: five anchors,
no stale "four"/"third leg" wording anywhere in the section you add or edit.

Then regenerate the per-tool mirrors:

```bash
bun run ai/mapper/index.ts
```

> The mapper rewrites `.claude/knowledge/...`, `.cursor/...`, etc. from the `ai/` source. Those
> generated files are gitignored-by-policy outputs you must not hand-edit; running the mapper is
> the only correct way to propagate the doc change.
>
> Optional, low-priority cleanup (only if you are comfortable): the doc's final `[source: ...]`
> line (`desktop-routing.md:138`) cites a `.personal/plans/...` path, which violates the
> no-personal-refs-in-committed-code rule. You may drop that one cite while you are in the file;
> it is not required for this phase.

---

## 5. Execution order & commands

Do the `proxai_nest` changes first (they are the required core); the gateway change (§3.5) is
independent and can be done in either order.

### proxai_nest
1. Edit `src/agent-gateway/parsers/parsers.versions.ts` (§3.1 + §3.2).
2. Update + add tests in `parsers.versions.spec.ts` (§4.1) and the Desktop ACR test (§4.2).
3. Update `ai/knowledge/agent-gateway/desktop-routing.md` (§4.4) and run the mapper.
4. Run:
   ```bash
   bun run typecheck
   bun run test:unit src/agent-gateway/parsers/tests/parsers.versions.spec.ts
   bun run test:unit src/agent-gateway/parsers/claude-code/services/tests/claude-code-parse-chat.service.spec.ts
   bun run lint
   ```
   Do **not** run `bun run validate` while iterating.

### proxai_gateway (only if doing §3.5)
1. Edit `src/sources/claude-desktop/collect.ts` (§3.5).
2. Add the test in `src/sources/claude-desktop/tests/collect.test.ts` (§4.3).
3. Run:
   ```bash
   bun run typecheck
   bun test src/sources/claude-desktop/tests/collect.test.ts
   bun run lint
   ```

If any command fails, fix the cause — never silence it with a suppression or an `any`.

---

## 6. Audit / self-check before hand-back

Run these and confirm the expected output:

```bash
# proxai_nest — the new scheme is registered for Desktop (prefix-stripping), not bare semver
grep -n "claudeDesktopScheme\|CLAUDE_DESKTOP_SCHEMA_PREFIX\|CLAUDE_DESKTOP_VERSION_SENTINEL" \
  src/agent-gateway/parsers/parsers.versions.ts
grep -n "CLAUDE_DESKTOP:" src/agent-gateway/parsers/parsers.versions.ts
#   → CLAUDE_DESKTOP in VERSION_SCHEMES must read `claudeDesktopScheme`, NOT `semverScheme`.
#   → CLAUDE_DESKTOP in KNOWN_AGENT_SCHEMA_VERSIONS must STILL be `CLAUDE_CODE_VERSION_RANGES`.

# the range-array alias + frozen invariants are untouched
grep -n "CLAUDE_DESKTOP === \|toBe(\s*$" src/agent-gateway/parsers/tests/parsers.versions.spec.ts | head

# proxai_gateway (if §3.5 done) — Desktop collector now unions in the usage predicate
grep -n "isUsageBearingAssistantRecord" src/sources/claude-desktop/collect.ts
#   → present in BOTH the import and the filter condition.
```

Confirm by reading, not just grepping:
- `VERSION_SCHEMES.CLAUDE_DESKTOP` points at `claudeDesktopScheme`.
- `KNOWN_AGENT_SCHEMA_VERSIONS.CLAUDE_DESKTOP` is still the by-reference `CLAUDE_CODE_VERSION_RANGES`.
- You did NOT add a new metric, schema column, migration, module, or queue.
- You did NOT edit `.claude/knowledge/...` by hand (you edited `ai/knowledge/...` + ran the mapper).
- You did NOT touch `parser-registry.service.ts`, `semverScheme`, `isDialogueRecord`, or
  `claude-code/collect.ts`.

---

## 7. Hand-back report (send this back to the orchestrator / verifier)

Report **exactly** this:

1. **Files changed** (path + one-line description), per repo. State explicitly whether you did
   the §3.5 gateway collector change or deferred it (and why).
2. **The source diffs** pasted verbatim: the `parsers.versions.ts` `claudeDesktopScheme` block +
   the `VERSION_SCHEMES` entry; and (if done) the `claude-desktop/collect.ts` import + filter.
3. **Test results:** paste the pass output of every command in §5.
4. **Sequencing confirmation:** state whether Phases 1, 4, and 5 are ✅ merged. If they are not,
   flag that lighting up Desktop now exposes a known under-counting / corruption path (§2.2).
5. **The two flagged DECISIONS** (§3.1 sentinel handling; §3.5 gateway collector) — confirm which
   option you implemented and that you did not silently change the sentinel semantics.
6. **Knowledge doc:** confirm you edited `ai/knowledge/agent-gateway/desktop-routing.md` (the
   source) and ran `bun run ai/mapper/index.ts`.
7. **Anything you could not do without an `any` or a suppression** — name the exact type friction
   instead of working around it.

---

## 8. Acceptance criteria (the verifier will check all of these)

- [ ] **Sequencing gate:** Phases 1, 4, 5 are ✅ merged before this lands (per ROADMAP status
      board). If not yet, the hand-back flags the under-count exposure.
- [ ] A **prefixed `claude-desktop/v2`** version resolves to `claude-code/v1`; Desktop chats no
      longer hit `UNSUPPORTED_VERSION` (proved by §4.1(c)).
- [ ] A **prefixed real CC semver** (`claude-desktop/2.1.92`) resolves to `claude-code/v1`, and an
      **out-of-range** prefixed semver (`claude-desktop/3.0.0`) is still gated to `null`/UNSUPPORTED.
- [ ] A **bare** semver (no `claude-desktop/` prefix) does NOT resolve for `CLAUDE_DESKTOP`.
- [ ] The reference test exists (§4.1) and the Desktop-routes-to-CC-parser ACR test exists (§4.2),
      asserting the Phase-1 fold (`inputTokens = input + cache_creation`, raw `cacheCreation` kept).
- [ ] `parsers.versions.ts` Desktop comment is corrected and `desktop-routing.md` documents the
      version-resolution cause (+ mapper run).
- [ ] (If §3.5 done) Desktop's collector keeps usage-bearing `tool_use` records; the gateway test
      proves the per-call usage reaches the uploaded body.
- [ ] `KNOWN_AGENT_SCHEMA_VERSIONS.CLAUDE_DESKTOP` is still the by-reference CC alias; the
      reference-identity + frozen tests stay green.
- [ ] All new/updated tests green; `typecheck` and `lint` pass in both repos touched.
- [ ] No `any`, no suppression comments, no before/after references; no schema/migration/metric/
      module/queue added; conventional-commit discipline left to the operator.

---

## 9. Out of scope + cross-phase dependencies

**Cross-phase dependencies (build order is load-bearing):**
- **Depends on Phase 1** (merged): the nest fold in `claude-code/extractors/usage.ts` (Desktop
  inherits via the shared parser) AND the gateway export `isUsageBearingAssistantRecord` (§3.5
  imports it). Do not re-implement either.
- **Depends on Phase 4** (shared upsert shrink-guard) and **Phase 5** (CC orphan-drop): both live
  in shared CC / spine code, so Desktop inherits them automatically. They must be merged first so
  lighting up Desktop does not expose an un-guarded corruption / orphan-drop path.
- **Blocks Phase 11:** once Desktop resolves, Phase 11's re-parse populates historical Desktop
  S3 captures. (Caveat: Desktop captures taken *before* §3.5 ships were already trimmed by
  Desktop's collector at capture time — those pre-fix tool_use usage records are NOT in S3 and
  cannot be backfilled, exactly like Phase 1's CC history note. Re-parse recovers only what is in S3.)

**Out of scope — do NOT do these:**
- **Forking the Desktop parser.** Desktop stays on the shared `ClaudeCodeParserService` + the
  by-reference CC version-range alias. The fork is a *future* trigger (~5% of CC volume OR material
  schema divergence) documented in `desktop-routing.md`; do not pre-fork.
- **The other phases:** Codex over-count (P2), Gemini cache_creation (P3), upsert shrink-guard (P4),
  CC orphan-drop (P5), Codex re-attach (P6), Cursor (P8, deferred), id hardening (P9), web display
  (P10), backfill (P11).
- **No new schema column, no migration, no new metric, no new module/queue, no DTO change.** The
  `CLAUDE_DESKTOP` enum + its 4 Prisma CHECK constraints + the parser-registry case already exist.
- **Do not change `semverScheme`, `geminiScheme`, `isDialogueRecord`, `claude-code/collect.ts`, or
  `parser-registry.service.ts`.**
- **The 30-day dashboard precondition** (`proxai_web` shipping a `WHERE agent = 'CLAUDE_DESKTOP'`
  filter) is a `proxai_web` follow-up, not this phase.
