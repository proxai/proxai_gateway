# Gemini and Codex Token Aggregation Alignment (Claude Code Model) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Standardize Gemini and Codex token aggregation logic to align with Claude Code's model, reporting only non-cached prompt tokens in the `inputTokens` column and capturing cached tokens in `cacheReadInputTokens` for all new entries onwards.

**Architecture:** Update the `aggregateUsage` utilities in `gemini.utils.ts` and `codex.utils.ts` to subtract cache-read tokens from the input tokens during aggregation. Update respective parser unit tests to reflect the new non-cached expectations.

**Tech Stack:** NestJS, Vitest, PostgreSQL (Prisma)

---

## 📥 User Request

> "ok, don't deal with how to reset and recalculate the old data, just focus on changing the data system for new entries onwards for now. please create separate branch and implementation plan"

---

## 🔍 Context and Findings

Currently, the `inputTokens` column in the database is rendered directly as "Input Tokens" in the ProxAI Dashboard.

- **Claude Code Parser:** Maps `input_tokens` as only newly-processed (non-cached) tokens.
- **Gemini & Codex Parsers:** Map `input_tokens` as the total context size (non-cached + cached reads).

To resolve user confusion over inflated numbers, we will standardize all models to the **Claude Code Model** for new entries onwards:
$$\text{Billed/Reported Input} = \text{Total Input} - \text{Cache Read Input}$$

---

## 🛠️ Implementation Tasks

### Task 1: Update Gemini Parser and Test Suite

**Files:**

- Modify: [gemini.utils.ts](file:///Users/onurseckinsenoglu/repos/proxai/proxai_nest/src/agent-gateway/parsers/gemini/gemini.utils.ts#L408-L419)
- Test: [gemini.utils.spec.ts](file:///Users/onurseckinsenoglu/repos/proxai/proxai_nest/src/agent-gateway/parsers/gemini/tests/gemini.utils.spec.ts#L373-L395)
- Test: [gemini-extractors.spec.ts](file:///Users/onurseckinsenoglu/repos/proxai/proxai_nest/src/agent-gateway/parsers/gemini/tests/gemini-extractors.spec.ts#L260-L270)

* [ ] **Step 1: Update `aggregateUsage` in `gemini.utils.ts`**

  Subtract `cache_read_input_tokens` from `input_tokens` during rollup:

  ```typescript
  // target content to replace inside aggregateUsage loop:
  input += step.input_tokens ?? 0;
  // replacement content:
  const nonCachedInput =
    (step.input_tokens ?? 0) - (step.cache_read_input_tokens ?? 0);
  input += Math.max(0, nonCachedInput);
  ```

* [ ] **Step 2: Update `gemini.utils.spec.ts` assertions**

  Adjust the `input_tokens` expectation for the aggregate test:

  ```typescript
  // target content to replace:
  it('sums input/output/cache counters across steps that report any token field', () => {
    expect(
      aggregateUsage([
        step({
          input_tokens: 10,
          output_tokens: 4,
          cache_read_input_tokens: 2,
          cache_creation_input_tokens: 1,
        }),
        step({
          input_tokens: 6,
          output_tokens: 3,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 0,
        }),
      ]),
    ).toEqual({
      input_tokens: 16,
      output_tokens: 7,
      cache_read_input_tokens: 7,
      cache_creation_input_tokens: 1,
    });
  });

  // replacement content:
  it('sums input/output/cache counters across steps that report any token field', () => {
    expect(
      aggregateUsage([
        step({
          input_tokens: 10,
          output_tokens: 4,
          cache_read_input_tokens: 2,
          cache_creation_input_tokens: 1,
        }),
        step({
          input_tokens: 6,
          output_tokens: 3,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 0,
        }),
      ]),
    ).toEqual({
      input_tokens: 9, // (10-2) + (6-5) = 9
      output_tokens: 7,
      cache_read_input_tokens: 7,
      cache_creation_input_tokens: 1,
    });
  });
  ```

* [ ] **Step 3: Update `gemini-extractors.spec.ts` assertions**

  Adjust the test checking input tokens extraction over steps that don't report cache reads:

  ```typescript
  // target content to replace:
  it('returns authoritative summed input tokens across the buffered steps', () => {
    const steps = [
      step({ input_tokens: 10, output_tokens: 3 }),
      step({ input_tokens: 5, output_tokens: 2 }),
    ];
    expect(inputTokensExtractor.extract(null, makeCtx({ steps }))).toEqual({
      value: 15,
      confidence: 'authoritative',
    });
  });

  // replacement content:
  it('returns authoritative summed input tokens across the buffered steps', () => {
    const steps = [
      step({ input_tokens: 10, output_tokens: 3 }),
      step({ input_tokens: 5, output_tokens: 2 }),
    ];
    expect(inputTokensExtractor.extract(null, makeCtx({ steps }))).toEqual({
      value: 15,
      confidence: 'authoritative',
    });
  });
  ```

* [ ] **Step 4: Run Gemini tests to verify changes**

  Run:

  ```bash
  bun test src/agent-gateway/parsers/gemini/tests/gemini.utils.spec.ts
  bun test src/agent-gateway/parsers/gemini/tests/gemini-extractors.spec.ts
  ```

  Expected: PASS

---

### Task 2: Update Codex Parser and Test Suite

**Files:**

- Modify: [codex.utils.ts](file:///Users/onurseckinsenoglu/repos/proxai/proxai_nest/src/agent-gateway/parsers/codex/codex.utils.ts#L350)
- Test: [codex.utils.spec.ts](file:///Users/onurseckinsenoglu/repos/proxai/proxai_nest/src/agent-gateway/parsers/codex/tests/codex.utils.spec.ts#L253-L283)

* [ ] **Step 1: Update `aggregateUsage` in `codex.utils.ts`**

  Subtract `cached_input_tokens` from `input_tokens` during rollup:

  ```typescript
  // target content to replace inside aggregateUsage loop:
  inputSum = addTo(inputSum, usage.input_tokens);

  // replacement content:
  const nonCachedInput =
    usage.input_tokens !== undefined && usage.cached_input_tokens !== undefined
      ? Math.max(0, usage.input_tokens - usage.cached_input_tokens)
      : usage.input_tokens;
  inputSum = addTo(inputSum, nonCachedInput);
  ```

* [ ] **Step 2: Update `codex.utils.spec.ts` assertions**

  Adjust the aggregate test expectations to match the new non-cached rollup logic:

  ```typescript
  // target content to replace:
  const lines: CodexLine[] = [earlier, parseCodexLine(TOKEN_COUNT)!];
  const u = aggregateUsage(lines);
  expect(u.input_tokens).toBe(81); // 1 + 80
  expect(u.output_tokens).toBe(41); // 1 + 40
  expect(u.cache_read_input_tokens).toBe(15); // 0 + 15

  // replacement content:
  const lines: CodexLine[] = [earlier, parseCodexLine(TOKEN_COUNT)!];
  const u = aggregateUsage(lines);
  expect(u.input_tokens).toBe(66); // (1 - 0) + (80 - 15) = 66
  expect(u.output_tokens).toBe(41); // 1 + 40
  expect(u.cache_read_input_tokens).toBe(15); // 0 + 15
  expect(u.cache_creation_input_tokens).toBeNull();
  ```

* [ ] **Step 3: Run Codex tests to verify changes**

  Run:

  ```bash
  bun test src/agent-gateway/parsers/codex/tests/codex.utils.spec.ts
  ```

  Expected: PASS
