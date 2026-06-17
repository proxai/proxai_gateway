# Rebuild & Recalculation Analysis

This document outlines the comparative statistics between **Claude Code** and **Gemini** usage logs, the discrepancies identified in the data, and how the standardization plan aligns them.

## 📊 Discrepancy Overview

During initial runs, user statistics showed a massive difference in input and prompt sizes:

| Metric                     | Claude Code | Gemini (Antigravity) |
| -------------------------- | ----------- | -------------------- |
| **Prompts count**          | ~1,200      | ~600                 |
| **Total net input tokens** | 3.7M        | 74M                  |
| **Median prompt size**     | ~3,000      | ~120,000             |
| **Min prompt size**        | ~1,300      | ~58,000              |

### Analysis of the Discrepancy:

1.  **Rule Ingestion Bloat:** As detailed in [root_cause.md](./root_cause.md), Gemini was unconditionally ingesting all 52+ rules files (each at least ~1K–2K tokens) on _every_ interaction, setting the "floor" for prompt size to at least 58,000 tokens. Claude Code only loaded rules matching the active files, keeping the minimum prompt size around 1,300 tokens.
2.  **Historical Incomplete Records:** Older Gemini records created prior to parser standardization lacked input/output cache details, which poisoned the metrics.
3.  **Standardization Goal:** We aim to filter out records missing token counters and align Gemini's database mapping to only count non-cached tokens under `inputTokens` (subtracting `cacheReadInputTokens` from total prompt tokens), matching the Claude Code billing model:
    $$\text{Reported Input} = \text{Total Input} - \text{Cache Read Input}$$

---

## 📈 Efficiency Comparison Plan

When running the recalculation scripts, the following efficiency metrics are computed for each CLI/agent:

- **Prompt Volume:** Total prompt count over the target period.
- **Token Spend:** Net input, output, cache read, and cache creation tokens.
- **Per-Prompt Cost/Size:** Average and median prompt sizes.
- **Cache Efficiency:** The ratio of cache read tokens to total input tokens:
  $$\text{Cache Efficiency} = \frac{\text{Cache Read Input}}{\text{Total Input}}$$
  This metric tells us how well the tool utilizes caching to save costs.

---

## 💾 Recalculation Methodology

To safely evaluate database records:

1.  **Exclude Old Formats:** Skip any historical database rows that do not have `input_tokens`, `output_tokens`, `cache_read_input_tokens`, and `cache_creation_input_tokens` populated.
2.  **Process standard parser formats:** Standardize Gemini and Codex token aggregation logic to match Claude Code for all new entries onwards.
