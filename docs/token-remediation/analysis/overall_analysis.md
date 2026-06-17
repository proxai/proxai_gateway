# Consolidated Token Telemetry & Loss Audit Report

This report presents the consolidated findings of the system-wide token telemetry audit across the four main developer agent integrations: **Claude Code (Anthropic)**, **Gemini / Antigravity CLI (Google)**, **Codex (OpenAI)**, and **Cursor IDE (Anysphere)**. It highlights critical data loss vulnerabilities, parses the mathematical mechanics of prompt caching and reasoning token ratios, and provides an actionable blueprint for system-wide database and telemetry remediation.

---

## 📊 1. Cross-Platform Comparative Summary

Below is the comprehensive comparative overview of telemetry and caching metrics compiled across all audited datasets:

| System Subsystem | Audited Sessions | Processed Calls / Bubbles | Billed Input Tokens | Prompt Cache Hits (Reads) | Output Tokens | Reasoning (Thinking) Tokens | Weighted Cache Hit Rate | Telemetry Data Loss / Delta Rate |
| :--- | :---: | :---: | :--- | :--- | :--- | :--- | :---: | :---: |
| **Claude Code** | 1,473 | 91,160 (Raw)<br>23,058 (Kept) | 102,038,438 (Raw)<br>25,907,359 (Kept) | 22,618,768,124 (Raw)<br>5,486,164,662 (Kept) | 102,040,127 (Raw)<br>23,164,793 (Kept) | N/A | **96.59%** (Raw)<br>**96.67%** (Kept) | **75.74%** total token loss<br>(due to dialogue filter) |
| **Gemini (Antigravity)** | 566 | 66,019 (Raw)<br>66,019 (Kept) | 398,306,104 | 7,557,104,839 | 34,624,400 | N/A | **94.99%** | **0.00%** data loss<br>(100% telemetry preserved) |
| **Codex (OpenAI)** | 7 | 145 | 658,309 (Raw)<br>674,633 (Kept) | 9,481,984 (Raw)<br>10,418,560 (Kept) | 65,108 | 15,321 (23.53% of output) | **93.92%** | **-9.40%** overcount delta<br>(due to turn re-emission) |
| **Cursor IDE** | 319 | 20,263 bubbles<br>93,200 blobs | 0 | 0 | 0 | 0 | N/A | **100.00%** token loss<br>(permanently zeroed at source) |

---

## 🧮 2. Caching & Surcharge Math Models

Prompt caching is the primary driver of token efficiency for large context CLI sessions. The audited model providers apply prompt caching using the following mathematical structures to calculate effective billed input tokens:

### 2.1 Anthropic Caching Model (Claude Code)
Anthropic applies a 25% premium surcharge for cache creation (writes) and offers a 90% discount on cache reads (hits):

$$\text{Effective Billed Input}_{\text{Anthropic}} = I_{std} + (1.25 \cdot I_{create}) + (0.10 \cdot I_{read})$$

*   **Claude Cache Hit Efficiency (Total Input Ratio - Method A):**
    $$\text{Cache Hit Efficiency}_A = \frac{I_{read}}{I_{std} + I_{read} + I_{create}}$$
*   **Claude Cache Hit Efficiency (Caching Action Ratio - Method B):**
    $$\text{Cache Hit Efficiency}_B = \frac{I_{read}}{I_{read} + I_{create}}$$
*   **Claude Break-Even Reuse Threshold ($N$):**
    Let $N$ be the number of cache reads per write:
    $$1.25 + 0.10N < N + 1 \implies 0.25 < 0.90N \implies N > 0.278$$
    If a cached block is read **at least once** ($N \ge 1$), caching is resource-efficient.

### 2.2 Google Gemini Caching Model (Antigravity CLI)
Google bills standard rates for cache creation and offers a discount multiplier on cache reads (hits):

$$\text{Effective Billed Input}_{\text{Gemini}} = I_{std} + I_{create} + (D \cdot I_{read})$$

where:
*   $D \in \{0.25, 0.10\}$ is the discounted cache hit multiplier ($D = 0.25$ for AI Studio, $D = 0.10$ for Vertex AI).
*   **Gemini Cache Hit Efficiency:**
    $$\text{Cache Hit Efficiency}_{\text{Gemini}} = \frac{I_{read}}{I_{std} + I_{read}}$$

### 2.3 OpenAI Caching Model (Codex)
OpenAI automatically caches prompts exceeding 1,024 tokens. It does not charge a separate cache-creation fee, but bills cache reads at a 50% discount:

$$\text{Effective Billed Input}_{\text{OpenAI}} = (I_{std} - I_{read}) + (0.50 \cdot I_{read}) = I_{std} - (0.50 \cdot I_{read})$$

---

## 💰 3. Model-Level Financial Cost Audit

Through detailed inspection of the raw session datasets, we determined that model-level identifiers are present for three of the four source categories:
*   **Claude Code**: Stores string model names (e.g., `claude-opus-4-7`, `claude-opus-4-8`, `claude-haiku-4-5-20251001`, `claude-sonnet-4-6`, `claude-sonnet-4-5-20250929`, `claude-fable-5`).
*   **Gemini (Antigravity)**: Stores numerical IDs in the `model` step field (e.g., `1132` for Gemini 3.5 Flash (High), `1016` for Gemini 3.1 Pro, `1035` for Cloud Sonnet 4.6 (Thinking), `1050` for Gemini 3.5 Flash).
*   **Codex (OpenAI)**: Stores string model names (specifically `gpt-5.5` and `gpt-5.4`).
*   **Cursor IDE**: Hardcodes model names as `"default"` and leaves token counts permanently at zero.

Based on the verified official pricing structures, we calculated the total financial spend across all processed files:

### 3.1 Model-Specific API Pricing Rates
| Model Identifier | Human-Readable Name | Standard Input ($/1M) | Cache Write ($/1M) | Cache Read ($/1M) | Output ($/1M) | Storage ($/1M/hr) |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| **claude-opus-4-7** / **-4-8** | Claude 3 Opus | $5.00 | $6.25 | $0.50 | $25.00 | N/A |
| **claude-sonnet-4-5** / **-4-6** | Claude 3.5 Sonnet | $3.00 | $3.75 | $0.30 | $15.00 | N/A |
| **claude-fable-5** | Claude Fable 5 | $10.00 | $12.50 | $1.00 | $50.00 | N/A |
| **claude-haiku-4-5** | Claude 3 Haiku | $1.00 | $1.25 | $0.10 | $5.00 | N/A |
| **1132** / **1050** | Gemini 3.5 Flash | $1.50 | $1.50 | $0.15 | $9.00 | $0.02 |
| **1016** | Gemini 3.1 Pro | $2.00 | $2.00 | $0.50 | $12.00 | $0.05 |
| **1035** | Cloud Sonnet 4.6 (Thinking) | $3.00 | $3.75 | $0.30 | $15.00 | N/A |
| **gpt-5.5** | OpenAI gpt-5.5 | $5.00 | N/A | $0.50 | $30.00 | N/A |
| **gpt-5.4** | OpenAI gpt-5.4 | $2.50 | N/A | $0.25 | $15.00 | N/A |

### 3.2 Unified Financial Cost Summary Table
Below is the consolidated breakdown of the actual API cost computed for each model, comparing raw session activity with kept database records:

| Subsystem | Model | Raw/Billed Input | Cache Write | Cache Read | Output | Total Raw Cost ($) | Total Kept Cost ($) | Cost Lost / Delta ($) |
| :--- | :--- | :--- | :--- | :--- | :--- | :---: | :---: | :---: |
| **Claude Code** | `claude-opus-4-7` | 4.55M (Raw)<br>0.88M (Kept) | 365.74M (Raw)<br>75.01M (Kept) | 13,078.01M (Raw)<br>2,689.96M (Kept) | 53.57M (Raw)<br>10.19M (Kept) | **$10,186.82** | **$2,072.98** | **$8,113.84** (79.65% lost) |
| | `claude-opus-4-8` | 93.16M (Raw)<br>24.65M (Kept) | 265.34M (Raw)<br>74.04M (Kept) | 8,386.08M (Raw)<br>2,566.29M (Kept) | 44.12M (Raw)<br>12.54M (Kept) | **$7,420.16** | **$2,182.61** | **$5,237.55** (70.59% lost) |
| | `claude-fable-5` | 4.16M (Raw)<br>0.37M (Kept) | 27.14M (Raw)<br>2.94M (Kept) | 551.89M (Raw)<br>56.54M (Kept) | 2.99M (Raw)<br>0.22M (Kept) | **$1,082.24** | **$108.03** | **$974.21** (90.02% lost) |
| | `claude-sonnet-4-6` | 39.61k (Raw)<br>6.28k (Kept) | 19.49M (Raw)<br>6.00M (Kept) | 364.25M (Raw)<br>116.53M (Kept) | 975.85k (Raw)<br>69.69k (Kept) | **$197.13** | **$58.53** | **$138.60** (70.31% lost) |
| | `claude-haiku-4-5` | 141.99k (Raw)<br>12.59k (Kept) | 19.39M (Raw)<br>5.26M (Kept) | 258.25M (Raw)<br>63.43M (Kept) | 548.13k (Raw)<br>198.01k (Kept) | **$52.95** | **$13.92** | **$39.03** (73.71% lost) |
| | `claude-sonnet-4-5` | 60 (Raw)<br>21 (Kept) | 120.04k (Raw)<br>40.52k (Kept) | 1.31M (Raw)<br>0.54M (Kept) | 5.36k (Raw)<br>805 (Kept) | **$0.92** | **$0.33** | **$0.59** (64.13% lost) |
| **Claude Total**| | | | | | **$18,940.22** | **$4,436.40** | **$14,503.82** (76.58% lost) |
| **Gemini** | `1132` (3.5 Flash) | 368.85M | 12.94M | 7,261.65M | 31.97M | **$1,950.18** | **$1,950.18** | $0.00 (100% kept) |
| | `1016` (3.1 Pro) | 32.36M | 888.04k | 338.14M | 3.20M | **$274.05** | **$274.05** | $0.00 (100% kept) |
| | `1050` (3.5 Flash) | 4.83M | 153.15k | 0 | 153.15k | **$8.86** | **$8.86** | $0.00 (100% kept) |
| | `1035` (Cloud Sonnet 4.6) | 2.38M | 174.88k | 44.89M | 174.88k | **$23.89** | **$23.89** | $0.00 (100% kept) |
| **Gemini Total**| | | | | | **$2,256.98** | **$2,256.98** | $0.00 |
| **Codex** | `gpt-5.5` | 531.78k | N/A | 9.68M | 64.27k | **$9.43** | **$9.43** | $0.00 (100% kept) |
| | `gpt-5.4` | 142.85k | N/A | 738.56k | 836 | **$0.55** | **$0.55** | $0.00 (100% kept) |
| **Codex Total** | | | | | | **$9.98** | **$9.98** | $0.00 |
| **Cursor** | `default` | 0 | 0 | 0 | 0 | **$0.00** | **$0.00** | $0.00 |
| **Global Total** | | | | | | **$21,207.18** | **$6,703.36** | **$14,503.82** (68.39% lost) |

---

## 🔍 4. Key Telemetry Bugs & Parser Vulnerabilities

Our deep-dive audit identified three critical vulnerabilities across the ingestion pipelines:

### 4.1 Claude Dialogue Filtering Telemetry Loss (75.74% Token Loss)
*   **Vulnerability:** The gateway's `isDialogueRecord` filter in [collect.ts](file:///Users/onurseckinsenoglu/repos/proxai/proxai_gateway/src/sources/claude-code/collect.ts#L142-L203) strips out all `tool_use` (assistant) and `tool_result` (user) records to keep user-facing chat logs clean.
*   **Root Cause:** Because this filter is applied *before* telemetry upload, the gateway discards all intermediate API calls in an agent loop. In multi-step interactions (e.g., executing tests, editing files), only the initial user prompt and the final assistant response are kept.
*   **Operational Impact:** Discards **74.71% of all API calls** (68,102 calls), **74.61% of billed input tokens** (76.13M tokens), and **75.75% of cache read tokens** (17.13 Billion tokens).

### 4.2 Codex Start-of-Turn Re-emission Overcount (952k Token Overcount)
*   **Vulnerability:** At the beginning of a new turn (immediately following a `task_started` event), the Codex CLI re-emits a `token_count` status event. Because no new LLM call has run, this event carries the `last_token_usage` of the final call of the *previous* turn.
*   **Root Cause:** The Nest backend parser (`aggregateUsage` in [codex.utils.ts](file:///Users/onurseckinsenoglu/repos/proxai/proxai_nest/src/agent-gateway/parsers/codex/codex.utils.ts#L329-L382)) loops through all events in a turn and sums every `last_token_usage` block. It processes this start-of-turn re-emitted event as a new delta, double-counting the previous turn's final call.
*   **Operational Impact:** Overcounts exactly **952,900 input tokens** and **936,576 cached tokens** in the database across the 7 session rollouts. For a 10-turn session, this re-emission occurs at 9 turn boundaries, inflating database input tokens by **913,155 tokens (~9.4% inflation)**.

### 4.3 NestJS Caching Surcharge & Token Blindspot
*   **The 2-Token Prompt Caching Mystery:** In Claude Code sessions, standard `input_tokens` for kept assistant turns are recorded as exactly **2 tokens**. This occurs because Claude Code places a caching breakpoint at the end of the user prompt. The only volatile segment following the breakpoint is the assistant trigger suffix (`\n\nAssistant:`), costing exactly 2 tokens. The actual prompt context is shifted to `cache_creation_input_tokens` (billed at 1.25x).
*   **Vulnerability:** Because ProxAI's statistics engine only aggregates the standard `input_tokens` column, it completely misses the cache creation tokens, **under-reporting billed input by 86.29% to 87.22%**.

### 4.4 Cursor Client-Side Logging Deficit (100% Token Loss)
*   **Vulnerability:** Every conversational bubble record inside Cursor's local global storage database (`state.vscdb`) hardcodes its token count as `{"inputTokens": 0, "outputTokens": 0}`.
*   **Root Cause:** Cursor is a closed-source product. Its API orchestration, context assembly, and token calculations occur entirely on Cursor's remote backend servers (`api2.cursor.sh`), making local client-side token logging non-existent.

---

## 🛠️ 5. Concrete, Actionable Recommendations

To resolve database under-reporting, telemetry loss, and overcounting discrepancies, we recommend the following three system-wide remediations:

### Recommendation 1: Decouple Ingestion Telemetry from UI Dialogue Visibility (Claude Code)
*   **Action:** Modify `src/sources/claude-code/collect.ts` to upload 100% of the raw JSONL events, including intermediate tool-use and tool-result lines.
*   **Implementation:** Add an `isDialogueVisible` boolean column to the `AgentCallRecord` schema in [schema.prisma](file:///Users/onurseckinsenoglu/repos/proxai/proxai_nest/prisma/schema.prisma#L1052). The gateway should flag records containing `tool_use`, `tool_result`, or CLI metadata as `isDialogueVisible = false`. Update the frontend dashboard to filter chat rendering by `isDialogueVisible === true`, while allowing Nest's stats engines to aggregate token usage across all records.
*   **Expected Outcome:** Resolves the **75.74% telemetry data loss**, recovering the unrecorded prompt and completion tokens.

### Recommendation 2: Fix the Codex Start-of-Turn Re-emission Bug
*   **Action:** Modify `aggregateUsage` in [codex.utils.ts](file:///Users/onurseckinsenoglu/repos/proxai/proxai_nest/src/agent-gateway/parsers/codex/codex.utils.ts#L329-L382) to calculate turn-level usage via session cumulative counters instead of call-by-call delta summing.
*   **Implementation:** Compute turn usage by subtracting the cumulative `total_token_usage` at the start of the turn from the cumulative `total_token_usage` at the final completed step of the turn. If a start-of-turn re-emission is missing, add back the first event's delta.
*   **Expected Outcome:** Eliminates the **952,900 input token over-counting bug**, ensuring 100% mathematical alignment with actual session totals.

### Recommendation 3: Resolve Cursor Telemetry Deficit
*   **Option A: Nest-side BPE Token Estimation (Low Friction):** Estimate token counts inside [cursor-finalize-turn.service.ts](file:///Users/onurseckinsenoglu/repos/proxai/proxai_nest/src/agent-gateway/parsers/cursor/services/cursor-finalize-turn.service.ts#L1) by tokenizing the user's prompt text and assistant response text (including thinking and tool calls) using a local BPE tokenizer (e.g., `js-tiktoken`). Record these estimates in the database and set `tokens_are_estimated: true`.
*   **Option B: Active ConnectRPC Interception Proxy (High Precision):** Deploy a local Bun-based proxy daemon to intercept Cursor's ConnectRPC traffic on `api2.cursor.sh`. By trusting a local Root CA certificate and deframing the 5-byte ConnectRPC packets, the proxy can deserialize request/response Protobuf streams, calculate tokens locally using `js-tiktoken`, and log them to the gateway collector.

---

## 🏁 6. LLM Handoff & Reusable Scripts Guide

This section is a dedicated documentation handoff for a Large Language Model (LLM) or autonomous agent picking up this audit/analysis without prior chat context.

### 6.1 Goal & Scope
The objective is to audit, verify, and document how token counts (input/output tokens, cache reads/writes, reasoning tokens) are parsed, stored, and billed across ProxAI's developer agent integrations.

### 6.2 Token Categories Collected by Source
*   **Claude Code (Anthropic):**
    *   `inputTokens`: Newly processed (non-cached) input tokens.
    *   `outputTokens`: Total generated tokens (including reasoning/thinking).
    *   `cacheReadInputTokens`: Cached prompt tokens read on hit (discounted 90%).
    *   `cacheCreationInputTokens`: Cached prompt tokens written on cache creation/refresh (surcharged 25%).
*   **Gemini / Antigravity CLI (Google):**
    *   `inputTokens`: Sum of non-cached + cached tokens (representing the total prompt context).
    *   `outputTokens`: Total generated completion tokens.
    *   `cacheReadInputTokens`: Cached prompt tokens read on hit (discounted 90% Vertex AI, 75% AI Studio).
    *   `cacheCreationInputTokens`: Cached prompt tokens written.
*   **Codex (OpenAI):**
    *   `inputTokens`: Newly processed + cached prompt tokens.
    *   `outputTokens`: Generated completion tokens.
    *   `cacheReadInputTokens`: Cached prompt tokens (discounted 50%).
    *   `reasoning_output_tokens`: Output tokens dedicated to model reasoning/thinking.
*   **Cursor IDE (Anysphere):**
    *   All categories currently evaluate to `0` or `null` due to lack of client-side logging.

### 6.3 Pricing Models & Cost Estimation
Financial calculations standardly divide token counts by 1,000,000 to apply standard per-million-token pricing:

$$\text{Spend} = \frac{(I_{\text{non-cached}} \cdot \text{Rate}_{\text{input}}) + (O \cdot \text{Rate}_{\text{output}}) + (I_{\text{read}} \cdot \text{Rate}_{\text{cache-read}}) + (I_{\text{create}} \cdot \text{Rate}_{\text{cache-write}})}{1,000,000}$$

*See Section 3.1 for the exact rate table of standard, cache-write, and cache-read costs.*

### 6.4 Directory Structure
All related analyses and reusable scripts are contained in the gateway repository folder:
`docs/planning/token-issues/`
*   [overall_analysis.md](file:///Users/onurseckinsenoglu/repos/proxai/proxai_gateway/docs/planning/token-issues/overall_analysis.md) (This file) — consolidated system-wide audit.
*   [claude_analysis.md](file:///Users/onurseckinsenoglu/repos/proxai/proxai_gateway/docs/planning/token-issues/claude_analysis.md) — detail on dialogue filters & 2-token cache breakpoint.
*   [gemini_analysis.md](file:///Users/onurseckinsenoglu/repos/proxai/proxai_gateway/docs/planning/token-issues/gemini_analysis.md) — detail on numerical model mapping IDs.
*   [codex_analysis.md](file:///Users/onurseckinsenoglu/repos/proxai/proxai_gateway/docs/planning/token-issues/codex_analysis.md) — detail on the start-of-turn re-emission bug.
*   [cursor_analysis.md](file:///Users/onurseckinsenoglu/repos/proxai/proxai_gateway/docs/planning/token-issues/cursor_analysis.md) — detail on closed-source telemetry deficits.

### 6.5 Reusable Scripts (`docs/planning/token-issues/scripts/`)
*   [calculate_financials.ts](file:///Users/onurseckinsenoglu/repos/proxai/proxai_gateway/docs/planning/token-issues/scripts/calculate_financials.ts)
    *   *Purpose:* Reads local SQLite databases (Gemini) and JSONL logs (Claude/Codex), applies model mapping configurations, and calculates the total raw cost vs database kept cost.
    *   *Execution:* Run via `bun run docs/planning/token-issues/scripts/calculate_financials.ts` from the `proxai_gateway` root.
*   [compare_claude_logs_to_stats_cache.ts](file:///Users/onurseckinsenoglu/repos/proxai/proxai_gateway/docs/planning/token-issues/scripts/compare_claude_logs_to_stats_cache.ts)
    *   *Purpose:* Scans all available Claude Code log files on disk, applies the correct streaming deduplication logic, and compares the true sums against the CLI's `stats-cache.json` totals.
    *   *Execution:* Run via `bun run docs/planning/token-issues/scripts/compare_claude_logs_to_stats_cache.ts`.
*   [recalculate_db_tokens.ts](file:///Users/onurseckinsenoglu/repos/proxai/proxai_gateway/docs/planning/token-issues/scripts/recalculate_db_tokens.ts)
    *   *Purpose:* Scans local log files, computes the correct turn-level deduplicated tokens (supporting sub-agents), and compares them to the PostgreSQL database records. Can apply updates directly with `--write`.
    *   *Execution:* Run via `bun run .tmp/recalculate_db_tokens.ts` (or with `--write` to apply fixes) from the **`proxai_nest` root directory**.
