# Runbook: Redaction False Positive

Symptom: a user reports that the on-device redactor obscured something
it should have kept (a tool name, a model identifier, a JSON key, a
literal in their code).

## Phase 1: confirm the false positive

### 1. Capture a minimal repro

Ask the user for the exact characters that got obscured. Common
false-positive surfaces:

- Hex strings that match crypto-key patterns by coincidence (e.g.
  git short hashes).
- Email-like strings inside code samples.
- High-entropy base64 inside legitimate JSON values.

### 2. Run the dry-run redactor

```
proxai-gateway redaction test <path-to-file>
```

This is read-only (`ai/rules/services/redaction.md`: the command must
have no side effects). Output shows which rule fired and what was
replaced.

If the rule that fired is in the `PRESERVED_TOKENS` /
`PRESERVED_FIELD_CONTEXTS` exclusion sets (`services/redaction/preserve.ts`),
something is wrong with the preserve audit — go to Phase 3.

If the rule's regex matched something it should not have, go to
Phase 2.

## Phase 2: rule needs narrowing

### 1. Identify the rule

`ruleHits` in the `redaction test` output names the rule id. Find the
rule under `src/services/redaction/rules/`. Each category file
(`crypto-keys.ts`, `provider-tokens.ts`, etc.) defines one or more
`RedactionRule` entries with `id`, `pattern`, `replacement`.

### 2. Narrow the pattern

Tighten the regex to exclude the false-positive case. Common tools:
- Add a negative lookahead for known legitimate prefixes.
- Require a word boundary.
- Add a context-dependent guard (e.g. require a `key=` or `token:`
  prefix for shape-based fallbacks).

### 3. Run the fuzz-corpus self-test loop

```
bun run test:cov src/services/redaction/tests/<file>
```

The `auditRulesAgainstFixtures` test (`services/redaction/preserve.ts:147-163`)
runs every rule against every `PRESERVED_TOKENS` and
`PRESERVED_FIELD_CONTEXTS` fixture. If any rule matches any preserved
token, the test fails with the finding `{ruleId, fixture, match}`.

**Add the user-reported false positive as a new entry in
`PRESERVED_TOKENS` if it's a token that should never be obscured**
(e.g. a new tool name from a new agent version). Re-run the audit; it
will fail on every rule that matches the new token; fix each in turn.

### 4. Regression test for the original true-positive case

The rule existed for a reason. Add a positive fixture that confirms
the rule still fires on the original secret pattern. The
`tests/<rule-file>.spec.ts` file pattern is the home for these.

## Phase 3: preserve audit failure

If the false positive is something already in `PRESERVED_TOKENS` and a
rule is matching it anyway, the audit gate has regressed. Likely
causes:

1. A rule was added after the preserve token list, and the contributor
   didn't run the audit test.
2. A rule was edited and now matches an additional pattern.
3. The audit test was modified to filter out a finding (look for any
   recent change to `services/redaction/tests/preserve.test.ts`).

Fix the rule. Do NOT remove the token from `PRESERVED_TOKENS` to
"silence" the test — the token is preserved for a reason (it's part of
the JSON wire shape or an upstream-recognized identifier).

## Phase 4: single-pass invariant

`applyRedaction` (`redaction.ts:4-23`) is **single-pass**: it walks
`ALL_RULES` once in declaration order, replacing matches sequentially.
A rule that fires earlier in the list rewrites the text that later
rules see.

This means rule ordering matters. The `redaction.md` rule states:
"`crypto-keys` first, `keyword-secret` last. High-precision provider
patterns must precede generic shape-based fallbacks."

If a false positive is caused by a high-precision rule firing on the
output of an earlier replacement, the fix may be to move the high-
precision rule earlier (so it sees the original text, not the post-
replacement text). Audit fixture diffs both before and after the
move.

## What you must NOT do

- Add a `replacement` callback to bypass the literal-string rule. The
  `RedactionRule` interface enforces literal replacements
  (`ai/rules/services/redaction.md`).
- Add a side effect to `redaction test`. It's a local dry-run.
- Modify `source_path` redaction. Paths are transmitted unredacted by
  contract (`ai/rules/services/redaction.md`).

[source: src/services/redaction/redaction.ts, src/services/redaction/preserve.ts, src/services/redaction/rules/, src/services/redaction/tests/, .claude/rules/services/redaction.md]
