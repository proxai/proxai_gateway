# Cursor Token Collection — Opportunity Map & Plan

**Status:** investigation complete (verify-only; no code changed) · **Author:** Claude (Opus 4.8, ultracode) · **Date:** 2026-06-17

Question from the operator: Cursor currently contributes **all-null** token fields (`inputTokens`/`outputTokens`/`cacheRead`/`cacheCreation`) to `AgentCallRecord`. Is there a way to collect token info for Cursor "just like other sources"? This documents an exhaustive sweep of Cursor's local stores on a real machine, plus the server-API surface, and a tiered plan.

Method: read-only SQLite (`sqlite3 "file:<path>?mode=ro&immutable=1"`) over `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` (924 MB; tables `ItemTable` + `cursorDiskKV`), all per-workspace `workspaceStorage/*/state.vscdb`, the Chromium leveldb stores, and Cursor's own logs. Every claim uses a typed `json_extract($.path)` — raw substring greps for "token"/"usage" are FALSE POSITIVES because the payloads contain the user's own source code about tokens.

---

## 0. Bottom line

- **Per-turn / per-request BILLED tokens (input/output/cache) are NOT stored anywhere in Cursor's local data.** Exhaustively confirmed. Cursor bills server-side; the client writes `{0,0}` placeholders.
- **There is no first-party path to real billed tokens for an INDIVIDUAL user** — the personal session JWT yields only **dollar spend + quota %**, never token counts. Real per-request tokens exist only behind Cursor's **Team Admin API** (team admins, separate key, whole-team scope).
- **BUT Cursor DOES persist an input-CONTEXT-token gauge we currently ignore**, and most of it is **already in our production S3 captures, unextracted** — so a meaningful (if different) token signal is cheap to ship.

**Scope decision (2026-06-17):** the operator has **descoped the Cursor server connector** (no dashboard "Connect Cursor", no Team Admin API, no personal-JWT path). The plan in §3 relies **only on the local Cursor data the gateway already captures**. The server surface is retained in §2 purely as documented context should it ever be revisited.

The honest framing: we cannot reproduce the billed 4-column breakdown for Cursor, but we can surface a real **context-size** token metric (input-side), which for an agentic IDE is arguably the more useful number ("how big is this conversation / how close to the context limit").

---

## 1. What Cursor stores locally — the full map

| Signal | Store / path | Granularity | What it actually is | Captured today? |
|---|---|---|---|---|
| Billed input/output/cache tokens | `bubble.$.tokenCount` = `{0,0}`; `composer.$.usageData` = `{}` | — | placeholders, never populated | n/a (genuinely absent) |
| **`contextWindowStatusAtCreation.{tokensUsed,tokenLimit,percentageRemaining}`** | `bubbleId:` (user turns) | **PER-TURN** | input-context size at the turn's creation; rises monotonically through the convo | ❌ trimmed out by gateway (needs keep-key add) |
| **`contextTokensUsed` / `contextTokenLimit` / `contextUsagePercent`** | `composerData:` | conversation (latest snapshot) | input-context fill, latest value | ✅ **already shipped to S3 untrimmed** |
| **`promptTokenBreakdown`** | `composerData:` | conversation | input-context category split (system/tools/rules/skills/mcp/conversation) | ✅ already in S3 (new field, sparse) |
| `modelConfig.modelName` | `composerData:` | conversation | model attribution (claude-4.6-opus-high-thinking, gpt-5.4, gemini-3.1-pro, composer-2…) | ✅ already in S3 |
| `totalLinesAdded` / `totalLinesRemoved` | `composerData:` | conversation | code-change volume | ✅ already in S3 |
| `aiCodeTracking.dailyStats.v1.5.<date>` | global `ItemTable` | per-day | `{tab/composer}{Suggested,Accepted}Lines` — AI code-LINE counts | ❌ ItemTable not shipped |
| `aiCodeTracking.recentCommit` | global `ItemTable` | per-commit | `{aiPercentage, composerLinesAdded/Deleted}` | ❌ not shipped |
| `aiService.generations` | workspace `ItemTable` | per-request | generation COUNT + prompt text + `unixMs` (no tokens) | ❌ not shipped |
| Real billed $ spend | personal JWT → `DashboardService/GetCurrentPeriodUsage` | period | dollars + quota % (NOT tokens) | ❌ server, ToS-gray |
| **Real billed tokens** `{input,output,cacheWrite,cacheRead}` | **Team Admin API** `/teams/filtered-usage-events` | per-request | the real four columns + `chargedCents` | ❌ team-admin only, opt-in |

### Measured values (this machine, for reality-check)
- `tokenCount`: `{0,0}` on **all 20,262** bubbles (SUM=0, MAX=0). `usageData`: `{}` on all 318 composers. No `usageUuid` anywhere.
- `contextTokensUsed`: **237/319** composers, range **10,780 → 793,224**; `contextTokenLimit` up to **1,000,000**.
- `contextWindowStatusAtCreation`: **93** user bubbles, `tokensUsed` **27,249 → 200,000**, monotonic within a conversation.
- `promptTokenBreakdown` (1 composer): `totalUsedTokens 114,724 / maxTokens 200,000` → system 470, tools 7,432, rules 21,742, skills 3,822, mcp 3,666, subagents 817, conversation 76,775.
- Bonus: `totalLinesAdded` Σ 60,039 / `totalLinesRemoved` Σ 27,237; `aiCodeTracking` daily `composerAcceptedLines` up to 21,213/day.

### Exhaustively ruled out (so the negative is trustworthy)
Bubble `toolFormerData` (tool plumbing only), `capabilityContexts`/`consoleLogs`/`interpreterResults` (always empty), `modelInfo` (only `modelName`), `serverBubbleId`/`isRefunded` (IDs/zeros); `agentKv` `providerOptions` (only ids/phase/timestamps, no cacheControl/tokens); all other `cursorDiskKV` namespaces (no `aiUsage`/`generationData`/`messageRequestContext`); full `ItemTable` 535-key sweep (only lines/generations/auth); per-workspace DBs (`aiService.generations` = counts, no tokens); Chromium IndexedDB/Local/Session leveldb (`strings|grep` → zero usage records). The 27 `inputTokens`/`cache_read_input_tokens` value-hits in the whole 924 MB DB are the operator's own proxai_gateway source code stored as message content.

---

## 2. Server-side surface (DESCOPED — retained as context only)

> Not pursued per the 2026-06-17 scope decision. Documented so a future revisit has the facts; it is the **only** path to real billed Cursor tokens.

- **Personal path** (undocumented, reverse-engineered, auth = local `cursorAuth` HS256 JWT): `DashboardService/GetCurrentPeriodUsage` → `totalSpend` (cents) + quota percentages. **Dollars, not tokens.** ToS-gray (impersonates the desktop client; account-flag risk); short-lived JWT needs refresh rotation read from the live 924 MB DB.
- **Team Admin API** (official, auth = team-admin **API key**, Basic auth): `POST /teams/filtered-usage-events` → per-request `tokenUsage {inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens}` + `chargedCents`. **The only real-token source.** Team/Business/Enterprise admins only; whole-team scope. This machine's account is `free`/no-team and a team-scoped gRPC call already 403s.

---

## 3. Local-only collection plan (no Cursor connector)

This is what we can do relying **only on local Cursor data the gateway already captures**. All three exposure
options (A/B/C) are kept on purpose — the recommendation is marked, but the final choice is an
implementation-time decision for the operator.

### 3.1 The two data-plumbing changes (building blocks both options share)

| # | Change | Where | Cost | Unlocks |
|---|---|---|---|---|
| **P1** | Extract composer context fields | **nest parser only** — `cursor/extractors/usage.ts` (today returns authoritative-null) + `declaredFields` in `parsers.versions.ts`; parser already reads `composerData` (`cursor-extract-chats.service.ts` / `cursor-parse-chat.service.ts`) | tiny; **data already in S3** (composer rows ship untrimmed) | `contextTokensUsed`, `contextTokenLimit`, `contextUsagePercent`, `promptTokenBreakdown`, `modelConfig.modelName`, `totalLinesAdded/Removed` — per conversation |
| **P2** | Add `contextWindowStatusAtCreation` (and optionally `turnDurationMs` / `thinkingDurationMs`) to the bubble keep-list | **gateway** — `src/sources/cursor/process-rows.ts:56-67` `CURSOR_BUBBLE_KEEP_KEYS` | one line; takes effect on **new** captures only | per-turn input-context size `{tokensUsed, tokenLimit}` + per-turn latency |

P1 needs no gateway change and works on already-captured data. P2 is the only gateway touch, affects captures
taken after it ships (sparse field today — 93 bubbles — but a newer-version field expected to grow like
`promptTokenBreakdown`). Gate P2 emission on field presence so a 100%-miss `field_missing_total` doesn't fire.

### 3.2 The gauge-vs-flow rule (MUST honor — or downstream over-counts)

Cursor's context-token fields are a **gauge** (each turn's value already contains all prior turns' context —
monotonic 50k→180k through a conversation), NOT a summable **flow** like other agents' billed `inputTokens`.
Therefore:
- Conversation-level context = **MAX / latest**, never `SUM`, of the per-turn `tokensUsed`.
- Do **not** place a context-size value in the billed `inputTokens` column if any downstream path `SUM`s it
  across turns — it would over-count catastrophically (and would compound the Gemini double-count issue in
  `VERIFICATION_FINDINGS.md`).
- **Output tokens are the opposite** — independent and additive per turn — which is why output is the only
  billed column we can safely populate (as an estimate, Option B).

### 3.3 Exposure options (ALL retained; recommendation marked)

**Option A — Authoritative-only  ✅ RECOMMENDED FLOOR.** Surface only what Cursor itself measured; no
estimation; the four billed columns stay null.
- Context-size gauge (P1 + P2): `contextTokensUsed`/`Limit`/`Percent` (convo) and per-turn
  `contextWindowStatusAtCreation` — reported as max/latest, never summed.
- `promptTokenBreakdown` (where the context tokens go: system / tools / rules / skills / mcp / conversation).
- Productivity (fully authoritative): `totalLinesAdded` / `totalLinesRemoved`; and, if a later change ships the
  relevant `ItemTable` keys, `aiCodeTracking.dailyStats` (AI accepted/suggested lines + `aiPercentage`).
- Model attribution (`modelConfig.modelName`); request/generation counts (`aiService.generations`).
- **Pros:** 100% truthful; mostly already-in-S3; no tokenizer dependency. **Cons:** no output/cache numbers;
  the "tokens" shown are context-size, not billed.

**Option B — A + estimated output tokens  ⚙️ OPT-IN.** Tokenize the captured assistant response
(`text` + `thinking` + `toolFormerData`) and populate `outputTokens` with `tokens_are_estimated = true` (the
flag already exists in the schema; output is additive so it may use the real column).
- **Pros:** a real, summable per-turn output number where today there is nothing.
- **Cons:** it's an estimate — one BPE tokenizer approximated across many models (Claude / GPT / Gemini);
  slightly low for `agentKv`-shell conversations where the gateway drops reasoning before upload (normal bubble
  conversations keep text+thinking+tools and estimate well). Must be **visibly distinguished** from measured
  counts so it doesn't dilute the accurate counts the other agents produce.

**Option C — Full "token-usage" look  📝 DOCUMENTED, not recommended without guardrails.** Option B, plus expose
the context-size gauge as the "input" number on the Cursor view, labeled "context size (includes cache)".
- **Pros:** closest to the input+output column shape of the other agents.
- **Cons:** requires a hard guarantee that **nothing downstream `SUM`s** the Cursor input across turns
  (gauge-vs-flow); most caveated; highest risk of misleading aggregates.

### 3.4 Field shape — what lands where (invariant, regardless of option)

| Datum | Source field | Where on the record | Semantics |
|---|---|---|---|
| Estimated output (Opt B/C) | tokenize(text + thinking + tools) | `outputTokens` + `tokensAreEstimated=true` | additive (summable) |
| Per-turn context size | `bubble.contextWindowStatusAtCreation.tokensUsed` | `agent_metadata.context_tokens` — **NOT** `inputTokens` | gauge (max) |
| Convo context size / limit / % | `composerData.contextTokensUsed` / `contextTokenLimit` / `contextUsagePercent` | `agent_metadata` (conversation-level) | gauge |
| Prompt breakdown | `composerData.promptTokenBreakdown` | `agent_metadata.prompt_token_breakdown` | static snapshot |
| Model | `composerData.modelConfig.modelName` | model field | — |
| Lines added/removed | `composerData.totalLinesAdded` / `totalLinesRemoved` | `agent_metadata` | additive |
| Billed input / cache_read / cache_creation | — | **null** | unavailable in local data |

(Exact column vs. `agent_metadata` placement is an implementation choice. The non-negotiable invariant:
estimated output may use the `outputTokens` column with the estimated flag; context-size must **not** use the
summed `inputTokens` column.)

### 3.5 Bonus — productivity analytics (cheap, authoritative)

`totalLinesAdded/Removed` (per conversation, already in S3) and `aiCodeTracking.dailyStats` / `recentCommit`
(per-day & per-commit AI line counts + `aiPercentage`, e.g. "100% of this commit was AI, 231 lines") are
Cursor's *native* "how much did the AI produce" measure — fully authoritative, and a strong Cursor-specific
signal independent of the token question.

---

## 4. Recommendation & decision log

- **Descoped:** the Cursor server connector (Team Admin API real-token path + personal-JWT $ overlay) —
  operator decision 2026-06-17. Facts retained in §2 should it ever be revisited; it is the **only** source of
  real billed Cursor tokens.
- **Recommended now:** **Option A** (authoritative context-size + productivity), via plumbing **P1** (nest-only,
  data already in S3) and **P2** (one gateway keep-key line for the per-turn series).
- **Recommended opt-in:** **Option B** (estimated output behind `tokens_are_estimated`) **if** a token number in
  the standard column shape is wanted — gated so it reads as visibly distinct from measured counts.
- **Held for later:** **Option C** — only with a verified guarantee that no downstream sums Cursor input across
  turns.
- Under Options A and B, the billed `inputTokens` / `cacheRead` / `cacheCreation` columns stay **null/honest**;
  only `outputTokens` is ever populated (estimated, flagged). This keeps Cursor's "all-null billed" truthful
  while still giving Cursor users a real context-size + productivity story — i.e. the current "all null" is a
  *billed-token* gap, not a *no-data* gap.
- **Final call is the operator's at implementation time; all options above are retained as context.**
- Follow-up doc/knowledge edits when implemented: refresh the `extractors/usage.ts` docstring and the
  `cursor.md` knowledge file to state that billed tokens are absent by design but context-size + line metrics
  are available.
