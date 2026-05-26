# Agent Rationale

Two named agent personas live in `ai/agents/`. Each is a focused
reviewer with restricted tools and a single-purpose system prompt.
This file documents when to invoke each and why they exist as agents
rather than skills.

A subagent here is a `<n>.md` with YAML frontmatter (`name`,
`description`, `tools`, `model`) and the system prompt as the body.
Claude Code invokes via the Task tool with `subagent_type: <n>`. The
mapper distributes to per-tool agent surfaces (Claude:
`.claude/agents/`, Codex: `.codex/agents/` as TOML, etc. — but
SKIPPED for Antigravity per `ai/README.md`).

## `cross-platform-test-runner`

**Tools**: Read, Bash, Edit
**Model**: claude-sonnet-4-5
**When to invoke**: a single test or a CI failure is platform-
specific (Windows / Linux / macOS). The user has narrowed the failure
to one OS and wants the minimal canonical fix.

### Why this exists as an agent

Cross-platform bugs in this repo have a small, well-understood
catalogue of patterns (ten of them, listed in the agent's prompt).
The fix is mechanical once the pattern is identified:
- Path separator `'/'` literal → `node:path.sep` / `node:path.join`
- sqlite teardown EBUSY → `rmRecursive`, extend timeout to 30 s
- `?immutable=1` URI → explicit `SQLITE_OPEN_READONLY |
  SQLITE_OPEN_URI` flags
- `/bin/sh` in test → `bun -e '<script>'`
- ANSI assertion → `stripAnsi(s)` before regex
- 5 s default timeout for subprocess/interval tests → pass `30_000`
  as third arg to `test()`
- `mock.module(...)` leaking → pre-import real module; restore in
  `afterEach`
- Inline TOML missing required field → build through config validator
- Binary-not-on-PATH → inject `defaultSpawn`/`defaultWhich`
- "Extreme path" tests → NUL byte (`\0`)

A subagent is the right shape because:
1. The decision tree is fixed and deep. The catalog is 10 items, but
   identifying which one applies requires reading the test and the
   error output.
2. The fix is **minimum-change** by definition. The agent's prompt
   explicitly states "apply only the minimum change; do not refactor
   surrounding code" — otherwise the LLM is tempted to rewrite the
   test file wholesale.
3. The catalogue is stable. Adding an eleventh pattern is rare; the
   agent prompt rarely needs editing.

### When NOT to use this agent

- A test fails on all platforms — that's a logic bug, not a cross-
  platform pattern. Use the systematic-debugging skill.
- A test fails intermittently — concurrency/timing issue. Not in the
  catalogue.
- An entire test file is missing — need to write tests from scratch.
  Use the test-driven-development skill instead.

## `source-implementation-reviewer`

**Tools**: Read, Bash, Edit
**Model**: claude-sonnet-4-5
**When to invoke**: a new source under `src/sources/<agent>/` was
created or modified, and you want a focused review against the
six-point checklist (discovery glob, watermark advancement, sqlite
patterns, SOURCE_VARIANTS, no-any, test coverage) before merge.

### Why this exists as an agent

The source layer is the most error-prone area of the codebase
because:
- Five things must be in sync: the source files, contract variants,
  poll-worker registration, default-sources list, and tests.
- Watermark advancement on success vs error paths has burned
  reviewers before (the catch block must read prior cursor and
  re-upsert with `consecutiveErrors + 1`).
- Cross-platform sqlite gotchas overlap with the cross-platform
  agent's catalogue but are concentrated here.
- The agent reports findings as a structured list and **does not
  auto-fix**. The user reviews and applies.

A skill (`add-source-parser`) covers the *adding* path; this agent
covers the *review* path. The two are complementary — the skill
walks the contributor through the scaffold; the agent audits the
result before merge.

### When NOT to use this agent

- Reviewing a fix in an existing source (one-file change) — usually
  faster to read the diff directly.
- Reviewing non-source code (uploader, buffer, redaction) — out of
  scope for this agent.
- Adding a brand-new source from scratch — use the
  `add-source-parser` skill first; invoke this agent on the result.

## Why two narrow agents instead of one broad reviewer

Both agents trade breadth for two things:
- **Predictable output shape**. Each agent produces the same
  finding format every invocation; downstream users (and CI scripts)
  can rely on it.
- **Tool restriction**. Read+Bash+Edit only. They cannot Write new
  files, cannot run the WebFetch tool, cannot dispatch sub-agents.
  This makes their actions auditable.

A general-purpose "review my PR" agent would either lose the
specialized catalogues or become too long to be useful as a prompt.

## Mapper note

`agents/` is **SKIPPED for Antigravity** per `ai/README.md` — agents
don't have an equivalent in that tool. Codex receives them as TOML.

[source: ai/agents/cross-platform-test-runner.md, ai/agents/source-implementation-reviewer.md, ai/README.md, ai/mapper/emitters/agents.ts]
