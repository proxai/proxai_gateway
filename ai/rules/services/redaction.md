---
name: "Text Redaction and PII Masking"
description: "Single-pass redaction, literal string replacements, rule ordering, preserved tokens, and unredacted source path rule."
activation: "contextual"
scenarios: ["Adding a new PII or secret redaction rule", "Modifying redaction categories or preserved tokens", "Debugging data leaks in uploaded logs and record structures"]
globs: ["src/**/*.ts", "**/*.ts"]
---

# Redaction Rules


- `applyRedaction` must remain a single-pass design (walk `ALL_RULES` once, replace sequentially). Multi-pass or tree-based accumulation breaks the constant-memory guarantee and the splitter's size budget assumption.
- All rule `replacement` values must be literal strings only — no callback variant. The `RedactionRule` interface in `redaction.types.ts` enforces this; do not change it.
- Rules run in declaration order: `crypto-keys` first, `keyword-secret` last. High-precision provider patterns must precede generic shape-based fallbacks. Do not re-order categories without a full audit of fixture tests.
- `PRESERVED_TOKENS` and `PRESERVED_FIELD_CONTEXTS` in `preserve.ts` define the inverse contract. `auditRulesAgainstFixtures` is a CI gate. When adding a rule, verify it does not match any preserved token before committing.
- The `source_path` is transmitted unredacted (it is the absolute host path). Do not add a rule that matches path strings — that would corrupt the watermark routing on the server.
- New rules must be added to an existing named category file under `rules/`; never create a standalone rule outside `ALL_RULES`.
- `redaction test <file>` is a local-only dry-run; it never writes to the buffer. Do not add any side effects to this command path.
