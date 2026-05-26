# redaction

`src/services/redaction/` is the on-device PII/secret scrubber. It is invoked from each source's `collect.ts` **before** zstd compression. The size budget (`BODY_MAX_COMPRESSED_BYTES = 2 MiB`, `BODY_MAX_DECOMPRESSED_BYTES = 10 MiB`) is measured against the **redacted** body, so the splitter's "find largest prefix fitting both budgets" never sees pre-redaction sizes.

## Design

`applyRedaction(input, rules = ALL_RULES)` is intentionally a **single-pass** walk:

```ts
for (const rule of rules) {
  const matches = working.match(rule.pattern);
  const count = matches?.length ?? 0;
  if (count > 0) {
    working = working.replace(rule.pattern, rule.replacement);
    matchCount += count;
    ruleHits[rule.id] = count;
  }
}
```

Each rule sees the output of the prior rule. The pass is O(rules × input) but constant in additional memory beyond the working string. Multi-pass or tree-based accumulation would break the splitter's size assumption (post-redaction size could change mid-batch) and the constant-memory guarantee.

All rule `replacement` values are **literal strings** — never callback variants. `RedactionRule.replacement: string` enforces this at the type level.

## 13 rule categories (declaration order)

Order matters: high-precision provider patterns must match before generic shape-based fallbacks. `crypto-keys` runs first (multi-line PEM blocks would be partially clobbered by later rules), `keyword-secret` runs last (it is the lowest-precision shape catcher).

| Order | Category | Examples |
| --- | --- | --- |
| 1 | `crypto-keys` | GCP service-account `private_key` (must precede PEM), PEM private keys, PGP, Age, PuTTY, Minisign |
| 2 | `llm-providers` | OpenAI, Anthropic, Cohere, Mistral, Groq, etc. |
| 3 | `source-control` | GitHub, GitLab, Bitbucket, Gitea, Azure DevOps tokens |
| 4 | `cloud-providers` | AWS, GCP, Azure, Cloudflare, Linode, etc. |
| 5 | `generic-tokens` | Session IDs, long hex private keys, UUIDs near auth keywords |
| 6 | `communication` | Slack, Discord, Teams, Mattermost |
| 7 | `payment` | Stripe, Shopify, PayPal, Razorpay, Plaid |
| 8 | `auth-services` | Okta, Auth0, Twilio, SendGrid |
| 9 | `ci-package-managers` | CircleCI, Travis, npm, PyPI |
| 10 | `saas-tools` | Datadog, New Relic, Segment, Algolia, PagerDuty |
| 11 | `http-headers` | `Authorization`, `X-API-Key`, Cookie auth, AWS SigV4 |
| 12 | `connection-strings` | Postgres, MySQL, MongoDB URIs with embedded creds |
| 13 | `keyword-secret` | Generic `password=`, `token=`, `secret=` shape |

`ALL_RULES = RULE_CATEGORIES.flatMap(c => c.rules)`. There is no override / disable mechanism at runtime — the rule set is hard-coded.

## Replacement format

`[REDACTED:<rule-id>]`. The `rule-id` is the rule's `id` field (lowercase kebab). Server-side dashboards display the rule that fired so consumers can audit category coverage. Example replacements:

- `pem-private-key` → `[REDACTED:private-key]`
- `gcp-service-account-private-key` → `"private_key": "[REDACTED:gcp-service-account-private-key]"` (preserves the JSON field shape so downstream JSON parsing still succeeds)

## Preserve contract (`preserve.ts`)

`PRESERVED_TOKENS` (string[]) and `PRESERVED_FIELD_CONTEXTS` (string[]) enumerate tokens that **must never match** any rule. Examples:

- Conversation roles: `user`, `assistant`, `system`, `tool`
- Message-block types: `text`, `image`, `tool_use`, `tool_result`, `function_call`
- Tool names: `Read`, `Write`, `Edit`, `Bash`, `Grep`, `Glob`, `Task`, `WebFetch`, etc.
- Schema field names: `role`, `type`, `name`, `content`, `timestamp`, `model`, `cwd`, `session_id`, `composerId`, `bubbleId`
- Stop reasons: `stop`, `length`, `content_filter`, `tool_calls`, `end_turn`, `max_tokens`
- Context fragments like `{"role": "user"}`, `{"type": "tool_use"}`, `{"finish_reason": "stop"}`

`auditRulesAgainstFixtures(rules, fixtures)` walks every rule against every fixture and returns `PreserveAuditFinding[]`. This is the CI gate — any non-empty result fails the audit. When adding a new rule, the test suite (`tests/`) runs the audit and the rule must produce zero findings.

## Fuzz corpus self-test

The test suite under `src/services/redaction/tests/` includes a fuzz corpus (synthetic strings constructed to look like secrets but match preserved tokens). The audit runs `auditRulesAgainstFixtures(ALL_RULES, FUZZ_CORPUS)` and asserts empty output. This catches regressions when a new rule's regex accidentally matches the conversation-role token "user" or a tool name like "Bash".

## Per-format dispatch

Redaction does NOT dispatch by format — every source's `collect.ts` calls `applyRedaction(text)` on the **post-filter, post-trim string**. JSONL sources call it once per line (after filtering kept lines). KV/snapshot sources call it on the serialized JSON body. The single-pass walk is format-agnostic.

## `source_path` is intentionally NEVER redacted

`source_path` is the absolute host path (e.g. `/Users/alice/.claude/projects/.../session-id.jsonl`). It is transmitted unredacted as a DTO field, not embedded in the body. The redaction pipeline does not touch paths because (a) paths drive server-side watermark routing — corrupting them would lose the cursor mapping, (b) `source_path_hash` is the canonical key, and (c) the path itself is needed for the user-facing `status` and `tail` outputs. Adding a rule whose regex matches path strings would break watermark routing.

## CLI: `redaction test <file>`

A local-only dry-run. Reads the file, runs `applyRedaction(text)`, prints the result with per-rule hit counts. Never writes to `buffer.db`, never makes an HTTP request. Do not add side effects to this code path.

[source: src/services/redaction/redaction.ts:4-23; src/services/redaction/redaction.types.ts:1-19; src/services/redaction/rules/index.ts:30-103; src/services/redaction/rules/crypto-keys.ts:3-46; src/services/redaction/preserve.ts:3-163]
