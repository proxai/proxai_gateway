# Phase 3 — Implementation Instructions (for the implementer model)

> **Audience:** the small/fast implementer model that will write the code.
> **Author:** orchestrator chat (source-verified against `proxai_gateway` and
> `proxai_nest` on 2026-06-17).
> **Companion specs (already settled — do not re-open):**
> `../phase-03-gemini-phantom-cache-creation.md`, `../ROADMAP.md`
> (§"Column normalization", §"Per-turn token semantics"),
> `../analysis/VERIFICATION_FINDINGS.md` §10.1 + §11.1.
>
> Everything you need is here. Every path/line/snippet below was read from the
> actual source. **Follow it literally.** If a line number has drifted, trust the
> *named symbol* (function / field name), not the line number, and apply the same
> change at the symbol.
>
> **This phase is one-line of product code in `proxai_gateway`, plus tests.**
> No `proxai_nest` source change. No schema change. No migration. No new module.

---

## 0. TL;DR — what you are doing

Gemini's (Antigravity's) `cacheCreationInputTokens` column is a **phantom**. The
gateway decodes protobuf field `5.9.10` into it, but `5.9.10` is
`candidatesTokenCount` — the **visible-output** token count, a sub-slice that is
**already inside `outputTokens`** (proto `5.9.3`). Storing it again under
`cacheCreationInputTokens` re-represents output tokens as if they were cache-write
tokens. Gemini has no cache-creation concept at all.

You will make **one** product-code change:

1. **`proxai_gateway`** — in `src/sources/gemini/step-decode.ts`, stop mapping
   `5.9.10` into `cacheCreationInputTokens`. Emit `null` instead. Leave the three
   correct columns (`inputTokens` from `5.9.2`+`5.9.5`, `outputTokens` from `5.9.3`,
   `cacheReadInputTokens` from `5.9.5`) byte-for-byte untouched.

Then you update one existing gateway test (it currently asserts the phantom value)
and add one dedicated test.

**Total surface:** 1 gateway source file (`step-decode.ts`) + 1 gateway test file
(`tests/step-decode.test.ts`). That is the entire job.

> **Why no `proxai_nest` change (verified, see §5):** Nest's Gemini parser sums
> the per-step `cache_creation_input_tokens` into the per-turn column. Once the
> gateway emits `null` per step, that sum is `0` for new captures — no Nest source
> edit needed, and no Nest aggregate ever adds the column into a grand total. The
> reasoning-token field (Phase 3b) is **decided: SKIP** (ROADMAP, 2026-06-17), so
> there is no schema/extractor work here either.

---

## 1. Hard rules (non-negotiable — enforced by lint/CI/reviewers)

- **No `any`** — not `: any`, `as any`, `Promise<any>`, `Record<string, any>`,
  generic default `= any`, or implicit any, in source **or** `.test.ts`. Use
  `unknown` + narrowing at boundaries. If a 3rd-party type *forces* an any, **stop
  and report it**, don't insert one. (`proxai_gateway` bans it equally with
  `proxai_nest`.)
- **No suppression comments** — `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`,
  `eslint-disable`, `oxlint-disable`, `v8 ignore`. Fix the type instead.
- **No "before/after" references** in code, comments, or test names. Describe
  **current** behavior only. The new/updated test names say what the decoder does
  now (e.g. `it('does not populate cacheCreationInputTokens from proto 5.9.10 ...')`),
  never "no longer maps" / "used to copy".
- **Comments explain *why***, not *what*. No decorative banners.
- **Package manager: `bun`.** Gateway tests run on the **Bun test runner**:
  `bun test <path>`. Typecheck: `bun run typecheck`. Lint: `bun run lint`. Do **not**
  run the full coverage flow (`bun run test:cov`) while iterating. (Commands in §6.)
- **Git:** do **not** commit / push / branch / stage anything unless the operator
  explicitly tells you to. Make the edits and leave them in the working tree. The
  operator owns the branch and the PRs.

---

## 2. The mental model — READ THIS BEFORE WRITING CODE

### 2.1 What the gateway decodes today

`src/sources/gemini/step-decode.ts` → `decodeStep(stepType, payload)` walks the
Antigravity protobuf tree and produces a `NormalizedStep`. The token block lives
under proto field `5.9.*`. Verified mappings (`step-decode.ts:22-45`):

| `NormalizedStep` field         | Proto path                | Meaning                                              |
|--------------------------------|---------------------------|------------------------------------------------------|
| `inputTokens`                  | `5.9.2` + `5.9.5`         | non-cached prompt (`5.9.2`) + cached (`5.9.5`)       |
| `outputTokens`                 | `5.9.3`                   | **total** output (visible + thoughts) — CORRECT      |
| `cacheReadInputTokens`         | `5.9.5`                   | cache-read — CORRECT                                  |
| `cacheCreationInputTokens`     | `5.9.10`                  | **PHANTOM** — this is the bug                          |

The exact lines (`step-decode.ts:40-45`):

```ts
    model: modelVal !== null ? String(modelVal) : null,
    inputTokens: promptTokens !== null ? promptTokens + (cachedTokens ?? 0) : null,
    outputTokens: pNum(tree, '5.9.3'),
    cacheReadInputTokens: cachedTokens,
    cacheCreationInputTokens: pNum(tree, '5.9.10'),
  };
```

### 2.2 The proof that `5.9.10` is NOT cache-creation (VERIFICATION_FINDINGS §10.1)

Output decomposes exactly: **`5.9.3 == 5.9.9 + 5.9.10`**, measured on
**39,996 / 39,996** assistant steps that carry an output field (100.00%):

- `5.9.3` = `candidatesTokenCount` **total** output → what the gateway correctly
  stores as `outputTokens`.
- `5.9.10` = the **visible** output component (`candidatesTokenCount` visible slice),
  present on all **1,040** no-thinking steps where `5.9.10 == 5.9.3` and `5.9.9` is
  absent — the decisive proof of the assignment direction.
- `5.9.9` = `thoughtsTokenCount` (reasoning), present only when the model thinks;
  it is **unmapped/dropped** today and stays that way (Phase 3b skipped).

Ratio backstops on an 8,000-step run: median `5.9.10/output = 0.53`,
median `5.9.9/output = 0.47` (sum 1.00); and the cache-hit anomaly (`5.9.10 > 0` on
cache hits — impossible for genuine cache-creation, which is ~0 on a hit). Google's
own API has **no** cache-creation field; `usageMetadata` is
`promptTokenCount`, `cachedContentTokenCount`, `candidatesTokenCount`,
`thoughtsTokenCount`, `toolUsePromptTokenCount`, `totalTokenCount` — no cache-write.

**Conclusion:** mapping `5.9.10 → cacheCreationInputTokens` double-represents a
slice of output. `outputTokens` itself (`5.9.3`) is correct and must NOT be touched.
The fix is to stop populating `cacheCreationInputTokens` for Gemini.

### 2.3 Worked example (real-shaped numbers)

Take a step whose `5.9.*` envelope is `{ 5.9.2:1000, 5.9.5:4000, 5.9.3:600,
5.9.9:250, 5.9.10:350 }`. Note the identity holds: `5.9.3 (600) == 5.9.9 (250) +
5.9.10 (350)`.

| Column                        | Value today (wrong) | Value after fix | Source field            |
|-------------------------------|---------------------|-----------------|-------------------------|
| `inputTokens`                 | 5000                | **5000** (unchanged) | `5.9.2`+`5.9.5` = 1000+4000 |
| `outputTokens`                | 600                 | **600** (unchanged)  | `5.9.3`                 |
| `cacheReadInputTokens`        | 4000                | **4000** (unchanged) | `5.9.5`                 |
| `cacheCreationInputTokens`    | **350 (phantom)**   | **null**        | (none — Gemini has no cache-write) |

The phantom `350` is exactly the visible-output slice of the `600` output tokens
already counted in `outputTokens`. After the fix nothing of `outputTokens` is
double-represented, and the column truthfully says "Gemini reports no cache-write."

### 2.4 Why this is "latent, high severity"

No analytics reader sums Gemini `cacheCreationInputTokens` today (ROADMAP §pre-flight;
VERIFICATION_FINDINGS §10.1 — "*currently no live double-count*"). So nothing is
visibly wrong **yet**. But the column holds wrong data and is a landmine the moment
any reader computes `input + output + cacheRead + cacheCreation`. Phase 10 (web
KPI/label) is **blocked by** this phase precisely so the dashboard never starts
summing a phantom column.

---

## 3. CHANGE 1 — `proxai_gateway/src/sources/gemini/step-decode.ts`

**File:** `src/sources/gemini/step-decode.ts`

This is the one and only product-code edit in the whole phase.

### 3.1 Stop mapping `5.9.10` into `cacheCreationInputTokens`

Find the return object inside `decodeStep` (`step-decode.ts:40-45`):

```ts
    model: modelVal !== null ? String(modelVal) : null,
    inputTokens: promptTokens !== null ? promptTokens + (cachedTokens ?? 0) : null,
    outputTokens: pNum(tree, '5.9.3'),
    cacheReadInputTokens: cachedTokens,
    cacheCreationInputTokens: pNum(tree, '5.9.10'),
  };
```

Replace **only** the `cacheCreationInputTokens` line with a `null` literal plus a
why-comment. Leave the other four lines exactly as they are:

```ts
    model: modelVal !== null ? String(modelVal) : null,
    inputTokens: promptTokens !== null ? promptTokens + (cachedTokens ?? 0) : null,
    outputTokens: pNum(tree, '5.9.3'),
    cacheReadInputTokens: cachedTokens,
    // Gemini reports no cache-creation count. Proto 5.9.10 is the visible-output
    // token slice (candidatesTokenCount visible component) and is already inside
    // outputTokens (5.9.3 == 5.9.9 thoughts + 5.9.10 visible), so surfacing it as a
    // cache-write count double-represents output. Emit null — Gemini has no such field.
    cacheCreationInputTokens: null,
  };
```

That is the **entire** gateway source change.

### 3.2 Type-safety check (no cast, no `any`)

`NormalizedStep.cacheCreationInputTokens` is typed `number | null`
(`src/sources/gemini/gemini.types.ts:57`) and `GeminiStepRow.cache_creation_input_tokens`
is `number | null` (`gemini.types.ts:75`). A bare `null` literal is assignable to
both with no cast. `decodeStepRow` (`step-decode.ts:48-72`) copies the value through
unchanged (`cache_creation_input_tokens: step.cacheCreationInputTokens` at `:70`) —
**do not edit `decodeStepRow`**; it correctly carries the now-`null` value.

### 3.3 `pNum` stays imported (no dead-import lint error)

After removing the `pNum(tree, '5.9.10')` call, `pNum` is still used many times in
this file (`5.9.1`/`5.11` model, `5.9.2` prompt, `5.9.5` cached, `5.9.3` output,
`5.3` discriminator, etc.). Do **not** remove the `pNum` import. The **quoted proto-path
mapping** `pNum(tree, '5.9.10')` (the single-quoted literal `'5.9.10'`) should now appear
**nowhere** in `src/` (verified in §7 by grepping the quoted literal). Note that the **bare**
string `5.9.10` deliberately remains — in the why-comment you add in §3.1 and in the new test's
name and comments in §4 — and those occurrences are *wanted* (comments explain why; the test
name describes current behavior). Do **not** delete them, and do **not** grep for the bare
substring as a pass gate.

### 3.4 What you must NOT touch in the gateway

- **`inputTokens` (`5.9.2`+`5.9.5`), `outputTokens` (`5.9.3`), `cacheReadInputTokens`
  (`5.9.5`).** All three are correct (ROADMAP §"Per-turn token semantics" and the
  148-row Gemini proof). Leave them byte-for-byte.
- **`decodeStepRow`** — no change (it passes the field through).
- **`5.9.9` (`thoughtsTokenCount`)** — stays unmapped/dropped. Phase 3b
  (a reasoning field) is **decided SKIP** (ROADMAP, 2026-06-17). Do **not** add a
  new field, type member, or schema column.
- **`src/services/redaction/preserve.ts:81`** lists the string
  `'cache_creation_input_tokens'` in a redaction *key-preservation allow-list*. It
  preserves the key name through redaction; it does NOT read or aggregate the value.
  Leave it unchanged — it is harmless and correct (the key may still legitimately
  appear with a `null` value).

> **DECISION (flagged for reviewer): emit `null`, not `0`.** The acceptance criteria
> allow "null/0", but `null` is the right value: it truthfully means "Gemini has no
> cache-creation concept" (matching Codex, whose `cache_creation_input_tokens` is also
> `null`), it is the natural value for `pNum`-absent fields elsewhere in this decoder,
> and it matches ROADMAP §"Column normalization" ("null where the provider reports
> none"). Downstream, Nest's `aggregateUsage` coalesces per-step `null` to `0`
> (`?? 0`), so the stored per-turn column lands at `0` for new captures either way —
> but the *wire* value the gateway emits should be `null`. Do not emit `0`.

---

## 4. CHANGE 2 — Gateway tests

Runner: **`bun test <path>`** (Bun's built-in runner; globals `test`, `expect`
imported from `'bun:test'`). Gemini decode specs live in
`src/sources/gemini/tests/step-decode.test.ts`.

### 4.1 Update the one existing test that asserts the phantom value

`src/sources/gemini/tests/step-decode.test.ts` ends with the test
`'decodes token usage, caching, and model from step_payload 5.9 envelope'`
(`step-decode.test.ts:264-292`). Its fixture sets `5.9.10 = 80` and currently
asserts `cacheCreationInputTokens === 80` (line 284) and
`cache_creation_input_tokens === 80` (line 291). Those two assertions must now expect
`null`. Change **only** those two lines.

Find (`step-decode.test.ts:279-292`):

```ts
  const step = decodeStep(15, payload);
  expect(step.model).toBe('1132');
  expect(step.inputTokens).toBe(25000);
  expect(step.outputTokens).toBe(300);
  expect(step.cacheReadInputTokens).toBe(20000);
  expect(step.cacheCreationInputTokens).toBe(80);

  const row = decodeStepRow(42, 15, 3, payload);
  expect(row.model).toBe('1132');
  expect(row.input_tokens).toBe(25000);
  expect(row.output_tokens).toBe(300);
  expect(row.cache_read_input_tokens).toBe(20000);
  expect(row.cache_creation_input_tokens).toBe(80);
```

Replace with (only the two cache-creation assertions change; the rest are unchanged
regression guards proving input/output/cacheRead are untouched):

```ts
  const step = decodeStep(15, payload);
  expect(step.model).toBe('1132');
  expect(step.inputTokens).toBe(25000);
  expect(step.outputTokens).toBe(300);
  expect(step.cacheReadInputTokens).toBe(20000);
  // Gemini has no cache-creation field; proto 5.9.10 is a visible-output slice
  // already counted in outputTokens, so it is not surfaced here.
  expect(step.cacheCreationInputTokens).toBeNull();

  const row = decodeStepRow(42, 15, 3, payload);
  expect(row.model).toBe('1132');
  expect(row.input_tokens).toBe(25000);
  expect(row.output_tokens).toBe(300);
  expect(row.cache_read_input_tokens).toBe(20000);
  expect(row.cache_creation_input_tokens).toBeNull();
```

> The test name stays as-is — it accurately describes "decodes token usage, caching,
> and model"; correctly decoding "no cache creation" is part of that. Do not rename it
> to reference any change.

### 4.2 Add a dedicated test proving the phantom is gone while the rest is intact

Append this test to the **same** file. It uses the same proto-encode helpers already
imported at the top of `step-decode.test.ts` (`concatBytes`, `varintField`,
`msgField` from `sources/gemini/tests/proto-encode.ts`) and the same `decodeStep` /
`decodeStepRow` imports. It builds a step whose envelope satisfies the identity
`5.9.3 (600) == 5.9.9 (250) + 5.9.10 (350)`, then asserts cache-creation is `null`
and the other three columns reflect their own fields:

```ts
test('does not populate cacheCreationInputTokens from proto 5.9.10 (a visible-output slice already inside outputTokens)', () => {
  // 5.9.* token envelope: prompt(2)=1000, output(3)=600, cached(5)=4000,
  // thoughts(9)=250, visible(10)=350. Identity holds: 5.9.3 == 5.9.9 + 5.9.10.
  const payload = concatBytes([
    varintField(1, 15),
    msgField(5, [
      varintField(3, 2),
      msgField(9, [
        varintField(2, 1000),
        varintField(3, 600),
        varintField(5, 4000),
        varintField(9, 250),
        varintField(10, 350),
      ]),
    ]),
  ]);

  const step = decodeStep(15, payload);
  expect(step.inputTokens).toBe(5000); // 5.9.2(1000) + 5.9.5(4000)
  expect(step.outputTokens).toBe(600); // 5.9.3, untouched (still includes thoughts)
  expect(step.cacheReadInputTokens).toBe(4000); // 5.9.5, untouched
  expect(step.cacheCreationInputTokens).toBeNull(); // 5.9.10 is NOT cache creation

  const row = decodeStepRow(7, 15, 3, payload);
  expect(row.input_tokens).toBe(5000);
  expect(row.output_tokens).toBe(600);
  expect(row.cache_read_input_tokens).toBe(4000);
  expect(row.cache_creation_input_tokens).toBeNull();
});
```

### 4.3 The other Gemini gateway tests already pass — confirm, don't edit

- `src/sources/gemini/tests/collect.test.ts:164-216` decodes steps **without** a
  `5.9.*` envelope and already asserts `cache_creation_input_tokens: null` for each
  (lines 180, 197, 214). `pNum` returned `null` for those already, so the fix leaves
  them green. **Do not edit `collect.test.ts`.**
- No other gateway test references `5.9.10` or asserts a non-null Gemini
  cache-creation (verified in §7). Run the Gemini test file to confirm all green.

---

## 5. Why `proxai_nest` needs NO source change (verified reassurance)

You might assume nulling the gateway field needs a matching Nest edit. It does not.
Here is the verified data flow on the Nest side:

- The gateway ships each Gemini step row with `cache_creation_input_tokens` in its
  body. After §3 that value is `null` for every step.
- Nest's `aggregateUsage` (`proxai_nest/src/agent-gateway/parsers/gemini/gemini.utils.ts:396-438`)
  sums per-step token fields into the per-turn roll-up. The cache-creation line is
  `cacheCreate += step.cache_creation_input_tokens ?? 0;` (`gemini.utils.ts:419`),
  and the function returns `cache_creation_input_tokens: cacheCreate`
  (`:436`). With every step now `null`, `cacheCreate` sums to **`0`** — so the stored
  per-turn column is `0` for new captures. No Nest source edit required.
- **It is NOT additive into any grand total.** `aggregateUsage` returns
  `cache_creation_input_tokens` as its own field; nothing adds it into `input_tokens`,
  `output_tokens`, or `cache_read_input_tokens` (verified: the only writer/aggregate
  sites are `gemini.utils.ts:419/436` and the extractor at
  `gemini/extractors/usage.ts:53-57`, both of which keep it a separate column). So
  nulling it cannot under- or over-count any other column.
- The Nest Gemini unit tests that hardcode `cache_creation_input_tokens: 80/4/12`
  (e.g. `gemini/tests/gemini-extractors.spec.ts`,
  `gemini/tests/gemini-finalize-turn.service.spec.ts`) construct their **own**
  `GeminiStepRow` fixtures to exercise Nest's pass-through/sum behavior — they are not
  fed by the gateway and are **not** affected by this phase. **Do not touch them.**

If you nonetheless feel a Nest edit is warranted, **stop and report it** rather than
making one — Phase 3a is gateway-only by design, and the Nest pass-through is the
intended behavior (it lets a future provider that genuinely reports cache-creation
flow through unchanged).

> **Phase 3b (a Gemini reasoning/`thoughtsTokenCount` field) is DECIDED: SKIP**
> (ROADMAP, 2026-06-17). `outputTokens` stays the combined visible+thoughts total
> (correct). No Prisma schema change, no new extractor, no parser-output field. Do
> not start it.

---

## 6. Execution order & commands

All in `proxai_gateway`.

1. Edit `src/sources/gemini/step-decode.ts` (§3.1) — the one-line null + comment.
2. Update the existing test (§4.1) and add the dedicated test (§4.2) in
   `src/sources/gemini/tests/step-decode.test.ts`.
3. Run:
   ```bash
   bun run typecheck
   bun test src/sources/gemini/tests/step-decode.test.ts
   bun test src/sources/gemini/tests/collect.test.ts
   bun run lint
   ```
   `step-decode.test.ts` proves the fix + the per-column regression; `collect.test.ts`
   proves the end-to-end emitted rows (the already-null steps) still pass. Do **not**
   run `bun run test:cov` (the full coverage flow) while iterating.

If any command fails, fix the cause — never silence it with a suppression comment or
an `any`.

---

## 7. Audit / self-check before hand-back

Run these in `proxai_gateway`:

```bash
# 1. The phantom proto-path MAPPING is gone. Grep the QUOTED literal (the pNum call),
#    NOT the bare substring. The bare string `5.9.10` legitimately remains in the §3.1
#    why-comment and the §4 test name/comments — a bare-substring grep would falsely fail.
grep -rn "pNum(tree, '5\.9\.10')" src/   # expect: NO matches (the mapping is removed)
grep -rn "'5\.9\.10'" src/               # expect: NO matches (the single-quoted literal is gone)

# 2. cacheCreation for Gemini is null, and the three good columns are intact.
grep -n "cacheCreationInputTokens\|cacheReadInputTokens\|outputTokens\|inputTokens" \
  src/sources/gemini/step-decode.ts
#   expect: cacheCreationInputTokens: null  (with the why-comment)
#           inputTokens: ...5.9.2+5.9.5 / outputTokens: pNum('5.9.3') / cacheReadInputTokens: cachedTokens

# 3. No other gateway code reads/aggregates Gemini cacheCreation as additive.
grep -rn "cache_creation_input_tokens\|cacheCreationInputTokens" src/ | grep -iv "test"
#   expect: only step-decode.ts (now null + the pass-through in decodeStepRow),
#           gemini.types.ts (the type decls), and redaction/preserve.ts:81
#           (a key-name allow-list — NOT an aggregation). Nothing in a + / SUM.
```

Optionally, in `proxai_nest`, confirm no aggregate folds Gemini cacheCreation into a
total (you are NOT editing Nest — this is a read-only confirmation for the report):

```bash
grep -rn "cache_creation_input_tokens" src/agent-gateway/parsers/gemini | grep -iv "test"
#   expect: gemini.utils.ts (declared as its own return field + the `?? 0` per-step
#           sum into the SAME column), extractors/usage.ts (its own extractor),
#           finalize-turn.service.ts (reads it as its own column). NEVER inside a
#           + that also adds input/output/cacheRead.
```

If grep #3 or the Nest grep reveals a path that adds `cacheCreationInputTokens` into
a grand total, **do not "fix" it silently — stop and report it** (§8). Under the new
scheme that would be a double-count, but the prior analysis says no such reader
exists; surface it if reality disagrees.

---

## 8. Hand-back report (send this back to the orchestrator / verifier)

Report **exactly** this so the Opus verifier can check fast:

1. **Files changed** (path + one line each): `step-decode.ts` (one line),
   `step-decode.test.ts` (one updated test + one added test).
2. **The source diff** pasted verbatim (the `cacheCreationInputTokens` line + comment).
3. **The test diff** pasted verbatim (the two `.toBeNull()` updates + the new test).
4. **Test results**: paste the green output of the four commands in §6.
5. **Audit-grep results** (§7): paste grep #1 (must be empty) and grep #3, and state
   whether any path adds `cacheCreationInputTokens` into a total. If yes — describe it
   and **do not change it**; flag it.
6. **Confirm the flagged decision** was implemented as written: cacheCreation emits
   **`null`** (not `0`).
7. **Confirm you did NOT touch:** `inputTokens` / `outputTokens` / `cacheReadInputTokens`
   in `step-decode.ts`, `decodeStepRow`, `5.9.9`, `collect.test.ts`,
   `redaction/preserve.ts`, any Nest source file, any Prisma schema, any migration.
8. **Anything you could not do without an `any` or a suppression** — name the exact
   type friction instead of working around it (there should be none — `null` is
   assignable to `number | null`).

---

## 9. Acceptance criteria (the verifier checks all of these)

- [ ] Gemini captures no longer populate `cacheCreationInputTokens` — `decodeStep`
      emits `null` for it regardless of `5.9.10` (proved by §4.1 + §4.2). (3a — required)
- [ ] The quoted proto-path mapping `pNum(tree, '5.9.10')` (single-quoted literal `'5.9.10'`)
      appears nowhere in `proxai_gateway/src/` (§7 grep #1 empty). The **bare** string `5.9.10`
      deliberately survives in the §3.1 why-comment and the §4 test name/comments — that is
      expected and correct, not a failure.
- [ ] `inputTokens` (`5.9.2`+`5.9.5`), `outputTokens` (`5.9.3`), and
      `cacheReadInputTokens` (`5.9.5`) for Gemini are unchanged (asserted by the
      regression guards in §4.1 and §4.2).
- [ ] 3b reasoning field: **skipped** — no new parser field, no Prisma schema change.
- [ ] The updated test + the new dedicated test are green; `step-decode.test.ts` and
      `collect.test.ts` pass; `typecheck` and `lint` pass.
- [ ] No `any`, no suppression comments, no before/after references; conventional-commit
      discipline left to the operator.
- [ ] No `proxai_nest` source change; no aggregate adds Gemini `cacheCreationInputTokens`
      into a grand total (§7 confirmation).

---

## 10. Out of scope (do NOT do these — they are other phases or settled non-goals)

- **Phase 3b — a Gemini reasoning / `thoughtsTokenCount` (`5.9.9`) field.** DECIDED
  SKIP (ROADMAP 2026-06-17). No new field, no schema column, no extractor.
- **Any `proxai_nest` edit.** F3/3a is gateway-only. Nest's pass-through sum yields the
  correct `0` for new captures with no change (§5).
- **`outputTokens` / `inputTokens` / `cacheReadInputTokens`.** All correct; do not
  "improve" them. (Codex over-count is Phase 2; Claude Code usage preservation is
  Phase 1 — both already specced separately.)
- **Historical correction.** Nulling old rows is **Phase 11's** job (re-parse from S3
  nulls historical Gemini cacheCreation; or an operator-run targeted
  `UPDATE ... SET cache_creation_input_tokens = NULL WHERE agent = 'gemini'` — operator
  DML, **never** run by an agent). You only fix the forward decode path. It is harmless
  to leave historical rows as-is (nothing sums them) but cleaner to refresh later.
- The other phases: Claude Code (P1), Codex over-count (P2), upsert shrink-guard (P4),
  idle-flush orphan-drop (P5), Codex re-attach (P6), Claude Desktop version (P7), Cursor
  (P8), id hardening (P9), web display (P10), backfill (P11).

### Cross-phase dependencies

- **Depends on:** none. This phase is self-contained and can ship independently.
- **Blocks:** **Phase 10** (web KPI/label) — the dashboard must not start summing a
  phantom `cacheCreationInputTokens`; ship this first. Also feeds **Phase 11**
  (backfill re-parse nulls historical Gemini cacheCreation).
