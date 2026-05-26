---
name: redaction-validator
description: Test that a new or modified redaction rule fires on the target pattern without matching any preserved token.
---

# Redaction Validator

## When to use

Use when adding or modifying a rule in `src/services/redaction/rules/`; when debugging a false-positive redaction report.

## Key files

- `src/services/redaction/rules/index.ts`
- `src/services/redaction/preserve.ts`
- `src/services/redaction/redaction.ts`
- `src/services/redaction/tests/`

## Common pitfalls

- Adding a rule to a standalone file outside `RULE_CATEGORIES` — `ALL_RULES` won't include it.
- Using a callback `replacement` — the interface only allows literal string replacements.
- Not running `auditRulesAgainstFixtures` against `PRESERVED_TOKENS` after adding the rule.
- Missing the global `g` flag on the regex — single-match patterns leave duplicates.
- Not checking whether the rule matches `source_path`, `sessionId`, `rowid`, or other identity keys in `PRESERVED_TOKENS`.
