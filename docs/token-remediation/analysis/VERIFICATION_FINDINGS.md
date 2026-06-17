# Token-Issue Verification Findings (independent audit)

**Status:** confirmation protocols COMPLETE · **Auditor:** Claude (Opus 4.8, ultracode) · **Last updated:** 2026-06-17

Purpose: independently verify the small-LLM analyses in this folder (`claude_analysis.md`,
`codex_analysis.md`, `cursor_analysis.md`, `gemini_analysis.md`, `overall_analysis.md`) and the
`proxai_nest/scripts/Gemini stats/` docs. Verify against **source code + read-only production data**,
not recall. Every claim below has a file:line or a measured-data citation.

The user's framing: confirm whether input/output/cache token calculations are correct and whether
production metrics reflect them; the small model may have the *symptom* right but the *root cause / fix*
wrong; customers are affected.

---

## 0. Bottom line (FINAL — verified through 2 adversarial rounds; see §11)

| Area | Verdict | Confidence |
|---|---|---|
| Gemini `inputTokens` = non-cached (subtraction correct) | ✅ CORRECT (proven on prod) | High |
| Gemini per-step summing (double-count?) | ✅ No double-count — distinct per-call usage | High |
| **Codex start-of-turn re-emission double-count** | 🔴 **REAL BUG, confirmed on real rollout** | High |
| Codex `reasoning_output_tokens` dropped before DB write | 🟠 Confirmed dropped; *billing* impact TBD | High (drop) / Open (impact) |
| Claude Code per-call usage semantics (non-cached input) | ✅ CORRECT per kept record | High |
| **Claude Code under-count: dialogue filter drops usage-bearing tool-use records** | 🔴 **REAL — confirmed in code** | High |
| Cursor token fields all null (v1) | ✅ True — data gap, not a calc bug | High |
| Small model's "rule-bloat is the root cause of 74M" | 🟠 Minor contributor, not the driver | High |
| Small model's `check_raw_gemini_tokens.ts` verification | 🔴 Tautological — gives false confidence | High |
| Downstream stats/dashboard aggregation faithful (no double-sum) | ✅ Faithful (one label defect) | High |
| Any $ cost figure derived from these tokens | ✅ NONE — no cost column; offline-only | High |
| Codex over-count broader than turn boundaries (rate-limit re-emits) | 🔴 Confirmed; fix known & deferred | High |
| **Gemini `cache_creation` (proto 5.9.10) = real cache-creation?** | 🔴 **PROVEN NO — copy of the visible-OUTPUT count** (identity 5.9.3==5.9.9+5.9.10 on 39,996/39,996 steps carrying output). *Latent: currently no live double-count (no aggregate sums cacheCreation)* | High |
| **Claude Code idle-flush under-count (upsert-overwrite)** | 🔴 **CONFIRMED mechanism; impact CONDITIONAL** (needs promptId re-iterated post-flush + watermark-advance pivot unverified) + a separate silent orphan-drop path (§11) | High (mechanism) / Med (impact) |
| **Codex shares the idle-flush overwrite (turn_aborted/idle re-attach)** | 🔴 **NEW — confirmed (round 2);** Gemini immune | Med |
| **Claude Desktop produces ZERO ACRs (version-prefix mismatch)** | 🔴 **NEW — confirmed (round 2);** total data loss, masked by "0 prod rows" | High |
| Gemini idle-flush drops mid-turn continuation steps | 🟠 Real code path; DORMANT for gemini (0 in prod) | High |
| Gemini turnId (proto 5.12 "turnGroup") collision overwrite | 🟡 Plausible; multi-call turns are EXPECTED (3,060/3,312) | Low-Med |
| **Gemini per-request dedup absent (requestId 5.9.11 dropped)** | ✅ **NON-ISSUE — 40,000 steps, 40,000 distinct requestIds, 0 multi-usage** | High |
| Codex `reasoning_output_tokens` dropped = output under-count? | ✅ NO — output already includes reasoning (codex.utils.ts:360/362; OpenAI contract) | High |
| Schema `reasoning` column (schema:1246) = reasoning tokens? | ✅ NO — `BreadcrumbRecord.reasoning String @db.Text`, free-text rationale | High |

---

## 1. Empirical production data (read-only, measured 2026-06-16)

Probe: `proxai_nest/scripts/Gemini stats/verify_token_semantics.ts` (read-only via
`POSTGRES_URL_READ_ONLY_PROD` + `makeReadOnlyClient`). All-time, all-users `AgentCallRecord`.

| agent | rows | Σ inputTokens (non-cached) | Σ cacheRead | cache-read fraction | median input/turn |
|---|---|---|---|---|---|
| **gemini** | 1,341 | 4,176,556,331 | 4,560,817,892 | **52.2%** | **795,567** |
| **CLAUDE_CODE** | 15,463 | 14,320,806 | 44,815,100,854 | **100.0%** | **10** |
| **CODEX** | 1,853 | 1,461,137,411 | 1,382,359,040 | 48.6% | 20,074 |
| **CURSOR** | 1,670 | 0 (all null) | 0 | n/a | 0 |
| CLAUDE_DESKTOP | 0 | — | — | — | — |

Most data belongs to proxy users (per operator), but the columns are the columns the dashboard reads.

---

## 2. Gemini — input calc is CORRECT (the subtraction is right)

### 2.1 The two-repo round-trip nobody documented
- Gateway `proxai_gateway/src/sources/gemini/step-decode.ts:41`:
  `inputTokens = promptTokens(proto 5.9.2) + cachedTokens(proto 5.9.5)`; `cacheRead = 5.9.5`; `cacheCreation = 5.9.10`.
- Nest `proxai_nest/src/agent-gateway/parsers/gemini/gemini.utils.ts:415`:
  `nonCached = input_tokens − cache_read`.
- These **cancel**: `DB.inputTokens == proto 5.9.2` exactly. The gateway's `+cached` and nest's `−cached`
  are a round-trip no-op; the "fix" is equivalent to just shipping the raw non-cached `promptTokens`.

### 2.2 The linchpin (is 5.9.2 non-cached, or full promptTokenCount?) — SETTLED on prod data
If 5.9.2 were Gemini's full `promptTokenCount` (which by spec includes cached), it could never be < cached.
**148 prod Gemini rows have `inputTokens < cacheReadInputTokens`** — impossible unless 5.9.2 is the
**non-cached delta**. So the stored `inputTokens` is genuinely non-cached. The gateway test fixture agrees
(`proxai_gateway/src/sources/gemini/tests/step-decode.test.ts:281-291`: 5.9.2=5000 < cached=20000).
**The Gemini gemini_analysis.md §3.1 / Rec 2 "subtraction model is correct" claim is CONFIRMED.**

### 2.3 No per-step double-count
Per-step S3 inspection (record `090ade8b…`): each assistant step in the agentic loop carries DISTINCT,
growing usage (idx2 in=33388/read=0 → idx5 35198/8164 → idx7 35553/32648 …). These are separate model
calls, not one call's usage duplicated. Summing per-step (`gemini.utils.ts:408-419`) is legitimate.
Turn boundary = user-step → next user-step (`gemini-finalize-turn.service.ts:10-12, 87`).

### 2.4 BUT: the "fix" does NOT make Gemini comparable to Claude Code, and rule-bloat is not the driver
- Even after correctly removing cache-read, Gemini's non-cached input is **4.18B (median 795,567/turn)**
  vs Claude Code's **14.3M (median 10/turn)** — a ~290× gap that is **caching behaviour**, not arithmetic:
  CC caches ~100% (non-cached ≈ 0); Gemini caches ~52%, and the **first call of each turn has cacheRead=0**
  so it re-bills the full (huge) context as fresh input.
- The `scripts/Gemini stats/root_cause.md` "Antigravity rule-ingestion bloat → 74M" story is at best a
  minor contributor to a median ~6M-token total context. The mapper-frontmatter fix (commit `d0b283e1`)
  is a real *client-efficiency* improvement (fewer tokens sent) but is **not** a calculation fix.
- ⚠️ Per-call vs per-turn caching: gemini_analysis.md reports ~95% cache-hit (per-call, on a 566-file local
  snapshot). Prod ACR per-turn fraction is **52%**. Both can be true (per-call hits are high; each turn's
  first call misses), but the dashboard shows the 52% world. Worth reconciling.

---

## 3. Codex — 🔴 CONFIRMED start-of-turn re-emission double-count bug

### 3.1 The bug (codex_analysis.md §2 — VERIFIED on real data)
Real rollout `~/.codex/sessions/2026/05/20/rollout-…225369d.jsonl` (2 turns):

```
TASK_STARTED turn=…1879
   … TOKEN_COUNT last_in=18800 cached=14720 total_in=18800   (turn 1's real inference)
TURN_ABORTED
TASK_STARTED turn=…c51b
   TOKEN_COUNT last_in=18800 cached=14720 total_in=18800      ← RE-EMISSION of turn 1's last call
   TOKEN_COUNT last_in=22398 cached=14720 total_in=41198      (turn 2 call 1)
   TOKEN_COUNT last_in=30860 cached=21888 total_in=72058      (turn 2 call 2)
   TOKEN_COUNT last_in=35629 cached=30592 total_in=107687     (turn 2 call 3)
TASK_COMPLETE turn=…c51b
```

Nest sums every `last_token_usage` in the open turn (`codex.utils.ts:345-363`); a `token_count` has no
`turn_id` so it belongs to the most-recent `task_started` (`codex-parse-chat.service.ts:281`). Turn 2 stores
`18800 + 22398 + 30860 + 35629 = 107,687`, but the true turn-2 input is `total_end − total_start =
107687 − 18800 = 88,887`. **Over-count = 18,800 = exactly turn 1's last call** — matches the doc's claimed
18,800 for this session. Every turn after the first over-counts **both input and cache-read** by the prior
turn's final call.

### 3.2 Magnitude
Doc-measured ~**9.4% input** / **9.88% cache-read** over-count on 7 local sessions (10-turn session:
+913,155 input). Single-turn sessions: exactly 0. Prod Codex Σ inputTokens = 1.46B; a 9%-ish slice is
spurious for multi-turn sessions (exact prod fraction depends on the turn-count distribution — re-derive
before quoting a prod number).

### 3.3 Proposed fix assessment (doc §7)
Switching to cumulative subtraction `total_token_usage(end) − total_token_usage(start)` is **conceptually
sound** — the re-emission's `total` is the baseline, so it's naturally excluded (`107687 − 18800 = 88,887`).
Edge cases to scrutinise before shipping: partial-turn captures across watermarks (start/end totals in
different ticks), missing `total_token_usage`, and the `isFirstTCReemission` heuristic. **Simpler
alternative:** skip a turn's first `token_count` when its `total_token_usage` has not advanced past the
previous turn's end (i.e. drop the re-emission frame) and keep delta-summing.

### 3.4 `reasoning_output_tokens` dropped (codex_analysis.md §5.2 — confirmed drop; impact OPEN)
`codex.utils.ts:380` computes `reasoning_output_tokens`; `codex-finalize-turn.service.ts:305-325`'s
`result.usage` omits it; no `reasoning_output_tokens` column on `AgentCallRecord`. **Open + high impact:**
is codex `last_token_usage.output_tokens` already inclusive of reasoning (OpenAI standard → only a lost
breakdown) or additive (→ nest under-counts total output by the reasoning share, ~23% per the doc which
sums Standard+Reasoning=Total)? Resolve against codex-rs `TokenUsage` semantics before deciding severity.

---

## 4. Claude Code — 🔴 CONFIRMED systematic UNDER-count (dialogue filter drops usage)

### 4.1 Per-call semantics correct, but most calls never reach nest
`claude-code.utils.ts:405` sums `input_tokens` with NO subtraction — correct, because Anthropic's
`usage.input_tokens` already excludes `cache_creation`/`cache_read`. For the records nest *receives*, the
math is right.

### 4.2 The bug (claude_analysis.md §2-3 — VERIFIED in code)
The gateway's `isDialogueRecord` filter runs **before upload** (`proxai_gateway/src/sources/claude-code/collect.ts:251`
— only kept lines are uploaded). The filter (`collect.ts:142-203`) drops **every assistant record containing a
`tool_use` block**, via two gates: a **pure** tool_use record (no text block) is dropped at the `hasText` gate
(`collect.ts:184`: `if (!hasText) return false`), and a **mixed** text+tool_use record is dropped at
`collect.ts:200-202` (`hasToolUse → return !hasToolUse`) — losing both its usage AND its real text answer.
User `tool_result` records are dropped too. A Claude Code turn = `1 user prompt + N assistant tool-use cycles +
final text` (`claude-code-parse-chat.service.ts:15`); each of those N intermediate assistant responses is a
separately-billed API call carrying its own `usage`. They are all filtered out — **only the final text-only
answer reaches nest**. Nest then `aggregateUsage(records)` **sums over only the surviving records**
(`claude-code-finalize-turn.service.ts:99`, docstring line 16 "usage sums across the whole turn"). There is
**no separate usage-preservation path** for Claude Code (grep usage/token in gateway `src/sources/claude-code/*`
= empty) — unlike Codex which whitelists `token_count`. So dropped calls' tokens are permanently lost.

### 4.3 Effect
Systematic **under-count** of per-turn tokens, heaviest on `cache_read`, `cache_creation`, `output` (every
dropped tool-use call billed those). `input_tokens` (non-cached) is also under-counted but is small to begin
with (Anthropic caches ~everything — the "2-token mystery": standard input after the last cache breakpoint ≈
2 tokens; prod median non-cached input = 10/turn). Doc-measured loss on its dataset: ~74.6% input, ~77.3%
output, ~75.8% cache-read, ~76.6% cache-create. This is a major reason Claude Code looks tiny next to Gemini
(Gemini counts every call; Claude drops most). It is a **display-oriented filter with a telemetry
side-effect** — the proposed remediation (upload all lines, add `isDialogueVisible` to separate display from
telemetry) is the right shape. ⚠️ Caveat: the doc's "raw" totals SUM per-call usage across a session; that is
the correct *billed* total (Anthropic bills each call's cache-read separately), so summing is right — but
confirm the product intends "total billed across the agentic loop" vs "final/max context size" before sizing
the fix.

## 4b. Cursor
All four token fields hardcoded `null` in v1 (`cursor/extractors/usage.ts`). Prod: 1,670 rows, all token
fields null. Real data gap (Cursor users get no token stats), not a calc bug.

**Collection opportunity investigated 2026-06-17 — see `CURSOR_TOKEN_COLLECTION.md` (dedicated doc).**
Exhaustive local-store sweep (924 MB `state.vscdb`, all workspace DBs, Chromium leveldb, logs) + server-API
research confirm: **per-turn BILLED tokens are genuinely absent locally** (`tokenCount={0,0}` on all 20,262
bubbles, `usageData={}`, no `usageUuid`), and there is **no first-party path to real billed tokens for an
individual user** (personal JWT yields $ spend + quota % only; real per-request tokens exist only behind the
Team Admin API `/teams/filtered-usage-events`, team-admins only). BUT Cursor DOES persist an input-CONTEXT
gauge we ignore — `composerData.contextTokensUsed`/`contextTokenLimit`/`contextUsagePercent`/
`promptTokenBreakdown` (237/319 convos, 10.8k–793k tokens) **already shipped to S3 untrimmed** (nest-only
extract), plus per-turn `bubble.contextWindowStatusAtCreation` (sparse; one gateway keep-key change). **Server connector DESCOPED
(operator decision 2026-06-17)** — local-data-only plan in `CURSOR_TOKEN_COLLECTION.md` §3: plumbing P1
(nest-only composer extract, data already in S3) + P2 (keep-key add for per-turn). Three exposure options
retained for implementation-time choice: **A** authoritative context-size + productivity (recommended;
billed columns stay null — do NOT shove contextTokensUsed into the summed `inputTokens`, it's a gauge not a
flow), **B** A + estimated output tokens via `tokens_are_estimated` (opt-in), **C** full token-look (held,
needs a no-downstream-sum guarantee).

---

## 5. Small-model verification scripts — tautology (false confidence)
`scripts/Gemini stats/check_raw_gemini_tokens.ts` checks `(sumRawInput − sumRawCacheRead) == DB.inputTokens`.
But parsed `input_tokens` is already `promptTokens + cachedTokens` (gateway), and `DB.inputTokens` is that
minus cache_read — so the check is `5.9.2 == 5.9.2`, **always "✅"**, regardless of correctness. It cannot
detect the very error it purports to test. (`root_cause.md` rule-bloat thesis: see §2.4.)

---

## 6. Open questions (under verification by the running workflow)
1. Downstream: does any stats/metric/dashboard path re-add cache into "input", double-sum, or coerce
   Cursor nulls to 0 misleadingly? Are token metric names registered in `METRIC_KIND_REGISTRY`?
2. Codex output: reasoning inclusive vs additive (§3.4) — decides if there's an output under-count.
3. Gemini `cache_creation` (proto 5.9.10): genuine Gemini cache-creation, or a mislabeled field (e.g.
   thinking tokens)? Σ=7.27M, present on ~all rows.
4. Is there any **$ cost** computed from these tokens (nest or web)? If so the Codex over-count and any
   model-id→price mapping (gemini_analysis.md §7 mappings look unverified/possibly fabricated) propagate to $.
5. `claude_analysis.md` "75.7% dialogue-filter token loss / under-reporting" — verify or refute.
6. Verify the `reasoning` String column (schema:1246) is unrelated to reasoning tokens.

---

## 8. Small-model claim ledger + cautions

**The small model's three structural findings are GOOD and independently confirmed:**
1. Claude Code dialogue-filter token loss (under-count) — ✅ confirmed in code (§4 above).
2. Codex start-of-turn re-emission over-count — ✅ confirmed on real rollout data (§3 above).
3. Cursor 100% missing tokens — ✅ confirmed (null at source).
4. Gemini subtraction model correct — ✅ confirmed on prod (§2). (NOTE: `overall_analysis.md` §6.2 says
   Gemini `inputTokens` = "non-cached + cached / total prompt" — that is WRONG for the *current* code, which
   stores non-cached; `gemini_analysis.md` Rec 2 has it right. Doc internal inconsistency.)

**Where the small model is weak / wrong (do not action without re-verification):**
- `scripts/Gemini stats/root_cause.md` "rule-bloat caused 74M" — minor contributor, not the driver (§2.4).
- **Financial cost tables** (`overall_analysis.md` §3, per-agent §7): model-ID→name maps and per-MTok prices
  are largely **unverified and likely partly fabricated** — e.g. `claude-opus-4-7/4-8` labeled "Claude 3 Opus",
  speculative `gpt-5.5`/`gpt-5.4`, `Cloud Sonnet 4.6` routed via Gemini IDs, `claude-fable-5` at $10/$50.
  Treat every $ figure as indicative only. ⏳ Verify whether nest/web actually compute any cost from tokens
  (if not, these $ are the doc's own offline calc and not a production surface).
- `check_raw_gemini_tokens.ts` verification is tautological (§5).

**⚠️ Operational caution:** `docs/planning/token-issues/scripts/recalculate_db_tokens.ts` is documented (§6.5)
as runnable with `--write` to mutate the production DB. **Do NOT run it** (or any `--write`/UPDATE path) — this
session is verify-only; DML against prod is operator-territory.

**Severity / priority (by production blast radius, FINAL after confirmation protocols 2026-06-17):**
1. 🔴 **Claude Code under-count #1 (gateway dialogue filter)** — drops usage-bearing tool-use records before upload; most-used agent (15.5k ACRs); ~75% of cache/output telemetry lost. Biggest. Re-confirmed adversarially via the gateway's own fixture (§10.6).
2. 🔴 **Codex over-count** — sums duplicate `token_count` re-emits (turn-boundary AND rate-limit-only re-emits); fix known and explicitly deferred (`codex-finalize-turn.service.ts:308-323`, "v6 §A2").
3. 🔴 **Gemini phantom `cache_creation` (5.9.10) = visible-output copy** — PROVEN on 40,000/40,000 steps: `5.9.3(output) == 5.9.9(thoughts) + 5.9.10(visible)`. The `cacheCreationInputTokens` column re-stores a slice of output (Σ 7.27M), double-representing it; any `input+output+cacheRead+cacheCreation` sum over-counts. `outputTokens` itself is correct. Fix: null the Gemini cache-creation mapping (`step-decode.ts:44`); optionally map `5.9.9` to a real reasoning field. (§10.1)
4. 🔴 **Claude Code under-count #2 (idle-flush upsert-overwrite)** — CONFIRMED new mechanism (§10.3); a higher-watermark continuation overwrites the idle-flush row's tokens with a smaller post-flush window. Fires on the subset of the 1,274 prod idle flushes resumed mid-tool-loop on the same promptId (~60-380 turns). Silent. Independent of #1.
5. 🟠 **Cursor missing tokens** — all four fields null at source (v1); needs estimation or interception (larger project).
6. 🟡 **Gemini idle-flush mid-turn drop** — real path, DORMANT for gemini (0 prod idle flushes). Left in place as a latent guard target.
7. 🟡 **Web "Token Usage" KPI label mismatch** — value = input+output+cacheRead, subtitle says "Input + output"; for Gemini ~doubles the headline. Cosmetic. (Note: with #3, a naive 4-column sum would ALSO double-count the Gemini visible-output slice — fix #3 first.)

(Confirmed NON-issues: downstream double-summing; any $ cost surface; Codex reasoning under-count; Gemini input correctness; **Gemini per-request dedup / requestId over-count** (§10.2 — 40k distinct requestIds, 0 multi-usage); **schema `reasoning` column** (§10.5).)

## 9. Verification-workflow results (6 agents, all completed, 2026-06-16)

- **Codex (refined):** gateway passthrough confirmed; subtraction correct (OpenAI `input_tokens` includes cached — official docs). Over-count is BROADER than turn boundaries — codex-rs re-emits `token_count` on rate-limit-only updates with unchanged `total_token_usage` (openai/codex#14489, ccusage#884); nest sums with no advancement guard. The repo KNOWS the fix (diff `total_token_usage`) and deferred it. ccusage: `total`-diffing 100% accurate vs ~18% for summing. `reasoning_output_tokens` dropped is granularity-only (OpenAI `output_tokens` already includes reasoning). Stale doc: `extractors/usage.ts:4-8` says "last-wins" but code sums.
- **Downstream (faithful):** the 7 org-analytics ACR services sum the 4 token columns DISJOINTLY with `COALESCE(SUM,0)` — no double-count, cache_read never rendered as input; per-record detail is 1:1. MicroStats pipeline doesn't even read AgentCallRecord (it reads `logging_records` from SDK ingestion). No token VALUE hits `Logger.metric` → METRIC_KIND_REGISTRY moot. **No $ cost** is computed for agents (`cost_nano_usd` dropped; `estimatedCost:0`). One defect: web "Token Usage" KPI = input+output+cacheRead but subtitle "Input + output tokens" (low).
- **Root cause (confirms §2.4):** rule-bloat REFUTED as the driver; it's caching effectiveness + context size + agentic-loop summing. Mapper fix is client-efficiency only. Double-subtraction RISK if an agent follows the README plan literally (the "target line to replace" no longer exists). The doc's own numbers don't reconcile (74M single-user / 58k floor vs 795k prod median).
- **Inspector (confirms §5):** `check_raw_gemini_tokens.ts` tautological; README test expectations (gemini=9, codex=66) DO match committed tests; root_cause unverified. Two edge-case script-vs-parser divergences (capture-scope; input-or-output gating of cacheRead).
- **ext_docs (cache_creation):** Google docs confirm `promptTokenCount` includes cached (so Antigravity 5.9.2 must be a derived non-cached value — reconciles the 148-row proof). Gemini API has **no** cache-creation field; usageMetadata = promptTokenCount, cachedContentTokenCount, candidatesTokenCount, **thoughtsTokenCount**, toolUsePromptTokenCount, totalTokenCount. 5.9.10's shape ⇒ likely `thoughtsTokenCount`. All 5.9.x mappings are in-house RE with no public schema (version-bump fragility). The gateway add / nest subtract round-trip is correct but fragile + uncommented.
- **Adversarial (residual bugs):** (HIGH, dormant) idle-flush mid-turn drops continuation steps silently — `gemini-parse-chat.service.ts:206-215 → clearOpenTurn → :275`; no metric. (MED) turnId=proto 5.12 "turnGroup" collision → deterministic-id overwrite. (MED) per-step-row summing with no per-request dedup — requestId (5.9.11) decoded then dropped; correctness rests on the unverified "one usage row per call" invariant — the one plausible Gemini OVER-count vector. (LOW) cache_creation latent double-representation. (LOW) web `totalTokens=input+output` excludes cache_read → cache-heavy Claude Code reads as "near-free".

### Residual-risk read-only checks (run 2026-06-16)
- R1 (cache_creation=thoughts): Σ cacheCreation 7,275,216 = **38.7% of output**, **100%** of gemini rows have it, **0** rows with cc>output, **0** rows with output>0 & cc==0 → strongly consistent with thinking-tokens, not cache-creation.
- R2 (idle-flush): gemini flush_reason is **100% task_complete (0 idle_timeout)** → Gemini drop path dormant. CODEX 2 idle / 134 turn_aborted. **CLAUDE_CODE 1,274 idle_timeout** → check claude-code parser for the same drop.

## 10. Confirmation protocols — RESULTS (2026-06-17, all resolved)

Five protocols run: two raw-proto decodes (local Antigravity sqlite + gateway `scanProto`), three
source-analysis agents (≤4 concurrent). Every result below is grounded in either a 40k-step measurement
or a verified `file:line`.

### 10.1 🔴 Gemini `cache_creation` (proto 5.9.10) — PROVEN to be a copy of the visible-OUTPUT count
**The decisive identity, measured on 39,996/39,996 assistant steps that carry the `5.9.3` output field (100.00%; 4 of 40,000 decoded steps carry no `5.9.3` at all):** `5.9.3 == 5.9.9 + 5.9.10`. Independently reproduced in verification round 2 (§11). NOTE: the `confirm_gemini_total_field.ts` "hunt for a total field T" framing is the WRONG decider (there is no total field in the `5.9` envelope — the script prints "no candidate total field found"); the proof is the output-decomposition identity + ratio backstops (median `5.9.10/output`=0.53, `5.9.9/output`=0.47, sum 1.00) + the cache-hit anomaly.
- The genuine Antigravity proto survives ONLY client-side — the gateway decodes it and `JSON.stringify`s the
  mapped rows before upload (`proxai_gateway/src/sources/gemini/process-rows.ts:394`), so prod S3 can't answer
  this; the proto schema is universal, so the local corpus (500 DBs) is representative.
- **No `total` field exists anywhere in the step proto** (brute-force search of every path/depth found none),
  so the arithmetic-closure-against-total approach can't fire. Instead the OUTPUT-decomposition identity does:
  `5.9.3` (which the gateway correctly stores as `outputTokens`) = `5.9.9` + `5.9.10`. The two are the
  components of output: `5.9.10` = `candidatesTokenCount` (visible output, present on 39,990/40,000 steps and
  on **all** 1,040 no-thinking steps where `5.9.10 == 5.9.3` and field 9 is absent — the decisive proof of the
  assignment direction); `5.9.9` = `thoughtsTokenCount` (reasoning, present only when the model thinks).
- Backstops, same 8,000-step run: median `5.9.10/output = 0.53`; median `5.9.10/promptFull = 0.00131`
  (≈0 — no prompt relationship); **cache-HIT-with-creation = 100.0%** (7,576/7,577 cached rows also have
  `5.9.10>0` — impossible for genuine cache-creation, which is ~0 on a cache hit).
- **Conclusion:** the gateway maps `5.9.10` → `cacheCreationInputTokens` (`step-decode.ts:44`). So Gemini's
  `cacheCreationInputTokens` column is a **phantom** — it holds the visible-output token count, a sub-slice
  of `outputTokens`. Gemini's API has no cache-creation concept at all. Two consequences:
  1. **Double-representation:** the visible-output tokens are counted once correctly inside `outputTokens`
     and again as `cacheCreation`. Any consumer that sums `input+output+cacheRead+cacheCreation` as "total
     tokens" double-counts that slice (Σ cacheCreation = 7.27M).
  2. `outputTokens` itself is **correct** — `5.9.3` already includes thoughts (`5.9.9` + `5.9.10`). No output
     under-count for Gemini.
- The small model's hypothesis ("5.9.10 = thinking tokens") was directionally right (output-side, not cache)
  but had the wrong sub-field — it's the **visible** component, with thoughts living in the unmapped `5.9.9`.
  The correct fix is to **null/zero the `cacheCreationInputTokens` mapping for Gemini** (and optionally map
  `5.9.9` to a real `thoughtsTokens`/reasoning field if the product wants the breakdown). Do NOT keep it as
  cache-creation.
- Scripts: `proxai_nest/scripts/Gemini stats/confirm_gemini_proto_semantics.ts` (schema dump + closure),
  `confirm_gemini_total_field.ts` (total-hunt + correlation/anomaly).

### 10.2 ✅ Gemini per-request dedup (requestId 5.9.11) — NON-ISSUE, the over-count vector is dead
40,000 usage-bearing steps → **40,000 distinct `requestId`s; zero** requestIds carry more than one
usage-bearing step. Each usage row is a unique model call, so nest's per-step summing (`gemini.utils.ts:408-419`)
cannot double-count within a chat. `turnGroup` (5.12): 3,312 distinct turns, 3,060 span >1 requestId —
multi-call turns are EXPECTED and correct (a turn = many model calls), confirming summing-per-turn is the
intended model, not a bug. The 🟡 "per-request dedup absent" risk is empirically closed.

### 10.3 🔴 Claude Code idle-flush under-count — CONFIRMED, but a NEW mechanism (upsert-overwrite, not drop)
The audit had hypothesized a Gemini-style `clearOpenTurn` mid-turn DROP. The real mechanism is different and
I verified both load-bearing lines myself:
- Idle-flush emits ACR(X) with the full pre-idle usage (`claude-code-parse-chat.service.ts:236-253`,
  `aggregateUsage` over the replayed buffer), then clears the accumulator and nulls `openPromptId` /
  `openCaptureFirstWatermarkStr` (:439-443).
- If the user resumes the SAME `promptId` mid-tool-loop (e.g. approves a stale tool call >24h later), the
  continuation tick takes the `iterateChunkRecords` branch — NOT a full replay — because the replay branch
  requires `openPromptId && openCaptureFirstWatermarkStr`, both now null (**verified `:150-157`**). So the
  continuation re-emits ACR(X) with the SAME deterministic id but `aggregateUsage` over POST-flush records
  ONLY (a strictly smaller token window) and a higher `last_capture_watermark_end`.
- The upsert overwrites the earlier row: `ON CONFLICT (id) DO UPDATE SET … input_tokens/output_tokens/
  cache_creation_input_tokens/cache_read_input_tokens = EXCLUDED.*` gated by `EXCLUDED.last_capture_watermark_end
  > agent_call_records.last_capture_watermark_end` (**verified `parse-batch-upsert.service.ts:504-545`**).
  Higher watermark wins even though its token window is smaller → the pre-idle tokens are lost. No metric, no
  log, no Sentry; `parent_turn_id == turn_id` self-reference is the only tell.
- **Impact:** under-count by the pre-idle assistant usage on the SUBSET of the 1,274 prod CLAUDE_CODE idle
  flushes whose user resumes the same promptId mid-tool-loop (agent estimate ~5-30% ⇒ ~60-380 turns). This is
  a SECOND Claude Code under-count, independent of the gateway dialogue-filter drop (§4).
- **Fix surface:** refuse a watermark-advancing UPDATE that strictly shrinks `input_tokens+output_tokens`, OR
  merge usage with the existing row when `lastEmittedPromptId === openPromptId` on a re-emit.

### 10.4 ✅ Codex `reasoning_output_tokens` drop — granularity loss, NOT an output under-count (closed)
`codex.utils.ts:143-149` mirrors codex-rs `TokenUsage`; `:360` sums `output_tokens` and `:362` sums
`reasoning_output_tokens` into SEPARATE accumulators — never added together. OpenAI Responses API contract:
`output_tokens` is total completion tokens and `output_tokens_details.reasoning_tokens` is a SUBSET
(`total = input + output`; reasoning is not a third additive term). So the stored output already includes
reasoning; dropping the reasoning breakdown loses granularity only. §3.4 closed.

### 10.5 ✅ Schema `reasoning` column — unrelated to token counts (closed)
`schema.prisma:1246 reasoning String @db.Text` on model `BreadcrumbRecord` (block opens :1238) is the
breadcrumb agent's free-text classification rationale; its token counts live in the adjacent `metadata Json`
(:1249). Open Q6 closed.

### 10.6 ✅ Claude Code gateway dialogue-filter under-count (§4) — adversarially RE-CONFIRMED
Attacked on 4 axes; SURVIVES. Decisive evidence is the gateway's OWN fixture
`proxai_gateway/src/sources/claude-code/tests/fixtures/session-basic.jsonl:7`: a `tool_use`-only assistant
record carrying its own `usage` `{input:3,output:4}`, distinct from the preceding text record's `{input:1,
output:2}` — proving per-call (NOT cumulative) usage. `isDialogueRecord` drops it (`collect.ts:184` no-text
path, `:200-202` text+tool_use path); `grep usage|token proxai_gateway/src/sources/claude-code/*` is EMPTY
(no side-channel, unlike Codex's `token_count` whitelist); nest sums survivors only (`:99`) with no `max()`/
cumulative recovery. Real per-call billed usage is genuinely lost.

## 7. Methodology notes
- Read-only prod is authorised; scripts use `POSTGRES_URL_READ_ONLY_PROD` (prisma_reader, writes throw).
- Raw-proto confirmations (§10.1/10.2) decode the LOCAL Antigravity sqlite (`~/.gemini/antigravity-cli/
  conversations/*.db`, 500 DBs) via the gateway's `scanProto`/`getPath` — prod S3 holds only the gateway's
  post-decode JSON, so the full 5.9 envelope is local-only; the proto schema is universal across users.
- Verification runs at **≤4 concurrent agents with backoff** (8-at-once was rate-limited only because Claude
  Code was running another task concurrently); failed agents are tracked explicitly and re-run, never counted
  as completed.

---

## 11. Verification round 2 — adversarial re-verification + edge-case sweep (2026-06-17)

Multi-agent workflow: 11 adversarial verify/edge-case agents (≤4 concurrent, retry) + 1 synthesis. **0 agents
failed** — every finding is verified against `file:line`. Outcome: **all 5 findings HOLD, all 6 non-issues
HOLD, 2 NEW production issues surfaced, F4 impact-framing corrected, F3 made harmless-but-latent.** Full ranked
fix list: see `IMPLEMENTATION_PLAN.md` in this folder.

### 11.1 Findings re-verified
| Finding | Round-2 verdict |
|---|---|
| F1 — CC dialogue-filter under-count | **HOLDS** (re-confirmed via the gateway's own fixture `session-basic.jsonl:5/7` = distinct per-call usage). Citation precision fixed (§4.2). Biggest blast radius. |
| F2 — Codex re-emit over-count | **HOLDS** (no advancement/dedup guard; dedup exists only for duplicate `task_started`, never `token_count`). Stale docstring `extractors/usage.ts:4-8` ("use latest" vs code SUMS) flagged for code fix. |
| F3 — Gemini phantom cache_creation | **HOLDS** (identity independently reproduced). Now classified **latent**: harmless today because no aggregate sums `cacheCreation` — but the column holds wrong data and is a landmine for any future 4-column total. |
| F4 — CC idle-flush overwrite | **HOLDS (mechanism); impact CORRECTED** — see §11.3. |
| F5 — Cursor collection | **HOLDS** (feasibility + gauge-vs-flow confirmed; data already in S3 untrimmed). |
| 6 non-issues | **ALL HOLD** — downstream sums are disjoint `COALESCE(SUM,0)` and `cacheCreation` is never folded into any total (exactly why F3 is harmless); no $ cost; Codex output includes reasoning; Gemini 5.9.2 non-cached; dedup clean; `reasoning` column is free-text. Cross-capture + re-parse usage also confirmed idempotent (deterministic-id UPSERT-REPLACE, never arithmetic SUM). |

### 11.2 NEW issues surfaced (round 2)
- **🔴 Codex shares the idle-flush overwrite under-count** (NEW). A re-emitted `task_started{X}` for an
  already-flushed turn opens a FRESH turn with the same `X` — the duplicate-`task_started` guard
  (`codex-parse-chat.service.ts:233-242`) checks only `acc.openTurnId` (cleared post-flush), not
  `lastEmittedTurnId`; the re-opened turn aggregates only post-flush `token_count` deltas (no S3 replay,
  `:166-173`), then the shared upsert (`parse-batch-upsert.service.ts:540-545`, `W_new > W_old`) overwrites the
  original larger token sum. Population: **134 `turn_aborted` + 2 `idle_timeout`** prod Codex flushes. **Gemini
  is structurally immune** (unique-watermark user-step boundary; truncated/runaway flush drops the offending
  step at `gemini-parse-chat.service.ts:277-296` rather than continuing it).
- **🔴 Claude Desktop produces ZERO ACRs** (NEW; the "0 prod rows" was a *bug*, not low volume). The gateway
  stamps a prefixed `agentSchemaVersion` (`claude-desktop/v2`; `claude-desktop/collect.ts:171-180`,
  `claude-desktop.constants.ts:15`) but nest registers `CLAUDE_DESKTOP` under the plain `semverScheme`
  (`parsers.versions.ts:186`) with **no prefix strip** — unlike `geminiScheme` (`:163-178`) which strips
  `antigravity/`. `semver.valid` of a prefixed value is `null` → `resolveParserSet` returns null →
  `parse-process-chat.service.ts:125-145` marks every Desktop chat `UNSUPPORTED_VERSION` before any extractor
  runs. No test exercises a prefixed `claude-desktop/v2` resolution. Desktop also INHERITS F1/F4 by routing
  (shared `isDialogueRecord`), currently unreachable behind the short-circuit — so fix the version resolution
  ONLY after F1/F4, else you light up a known-undercounting path.

### 11.3 F4 correction (impact is conditional + a bigger sibling bug)
- The overwrite fires **only if** `promptId X` is re-iterated by post-flush chunks. Post-flush assistant /
  tool_result records carry **no** `promptId` (linked via `parentUuid`), so after the idle-flush nulls
  `acc.openPromptId`, the overwrite needs either a same-`promptId` USER record to reappear (off-protocol) OR
  the idle-flush failing to advance the main parse watermark so X's original USER record is re-read.
  **UNVERIFIED PIVOT:** whether the idle-flush queue advances the same `AgentParseState.last_processed_watermark`
  the main parser reads — must be grepped before sizing the prod impact.
- **Separate, silent orphan-drop path (plausibly the LARGER footprint):** `claude-code-parse-chat.service.ts:216-220`
  drops every post-flush assistant/tool_result chunk as an orphan (`continue`) once `openPromptId` is null. The
  `agent_gateway_parser_partial_turn_reset_total` metric (`:404`) fires only on the defensive partial-state
  branch (`:392-407`), NOT on this path — it is entirely silent. For a mid-tool-loop resume, every post-flush
  assistant token is lost.
- The shared upsert SET clause overwrites **~30 columns** (`parse-batch-upsert.service.ts:505-539`), not just
  the 4 token columns — `final_text`, `result_content`, `stop_reason`, `user_input_content`, timing — so a
  smaller-window re-emit is a broader **content-corruption** surface, not only a token under-count.

### 11.4 Citation/precision corrections applied to this doc
- §0/§10.1: F3 "40,000/40,000" → "39,996/39,996 steps carrying `5.9.3`"; `5.9.10` presence "every step" →
  "39,990/40,000 + all no-thinking steps." (applied)
- §4.2: the pure-`tool_use` drop is at the `hasText` gate `collect.ts:184`, NOT `:200-202` (which only drops
  mixed text+tool_use). (applied)
- §10.1: noted the `confirm_gemini_total_field.ts` "total-field closure" framing is the wrong decider (no total
  field exists); the identity + ratio backstops + cache-hit anomaly are the proof. (applied)
- Code-doc fixes deferred to implementation (NOT changed here, per verify-only scope): Codex
  `extractors/usage.ts:4-8` docstring ("use latest" → "SUMS"); `parsers.versions.ts:182-186` Desktop comment;
  `desktop-routing.md` ("0 rows = low-volume" → "0 rows = version short-circuit"). Listed in `IMPLEMENTATION_PLAN.md`.

### 11.5 Lower-severity round-2 notes
- 🟡 Web "Token Usage" KPI value = `input+output+cacheRead` (a 3-column disjoint sum via
  `agent-metrics-dashboard.tsx:45,49`) but subtitle says "Input + output tokens" — label understates; NOT an F3
  double-count (`cacheCreation` excluded). Cursor's null→0 coercion renders 0 tokens indistinguishable from
  "not captured."
- 🟢 (latent) `deterministicRecordId` silently falls back to sha256-truncation if `blake2b512` is unavailable
  (very old Node / FIPS OpenSSL), minting DIFFERENT ids → rollup double-count; only a `console.warn`. Moot on
  Node 24. `parsers.utils.ts:23-27`.
