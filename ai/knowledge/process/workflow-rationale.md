# Workflow Rationale

`ai/workflows/` is **currently empty**. This file documents why, and
what would qualify as a workflow if one were added.

## What a workflow is here

In this repo's `ai/` layout, a workflow is a slash-command prompt
template (`ai/workflows/<n>.md`) that the mapper distributes to each
tool's command surface (`.claude/commands/<n>.md`,
`.gemini/commands/<n>.toml`, etc.). It is invoked as `/<n>` and runs
without sub-agent isolation.

A workflow is good when:
- The task has a fixed, repeatable shape.
- The starting context is small (a file path, a PR number).
- The output is a structured artifact (a patch, a checklist, a report).
- Multiple repos share the same need (a workflow can be lifted into
  `~/.claude/commands/` if it generalizes).

## Why nothing is here yet

Most repetitive tasks in this codebase are covered by either:

1. **CLI scripts** (`bun run release`, `bun run test:cov`,
   `proxai-gateway inspect`) — these are deterministic and don't
   benefit from LLM judgment.
2. **Skills** (`ai/skills/<n>/SKILL.md`) — the existing three
   (`audit-sqlite-usage`, `add-source-parser`, `redaction-validator`)
   are stateful procedures with code references, not prompt
   templates.
3. **Agents** (`ai/agents/<n>.md`) — two named personas with tool
   restrictions and a focused review prompt.

What's left is mostly one-off triage, which doesn't need a workflow.

## Good candidates for future workflows

If a slash command is added later, the strongest candidates are:

### `/release-preflight`

Pre-flight check before `bun run release`. Verifies:
- Working tree clean
- On `main`, synced with `origin/main`
- No failing tests in the last CI run
- No new `[breaking]` or `migration:` commits since last tag without
  a corresponding entry in the release notes
- The next CalVer date is what the maintainer expects (catches UTC
  vs local-time confusion)

Drives the user to fix issues before `release.yml` rejects them.

### `/diagnose-stuck-daemon`

Reads `proxai-gateway status` output, last 2 h of `tail --level warn`,
and the sentinel filesystem. Walks the user through
`ai/knowledge/runbooks/debug-stuck-daemon.md`. Produces a structured
finding ("AUTH_FAILED with reason X, suggest setup new").

This is borderline a skill, but the value-add is the multi-step LLM
synthesis of the three command outputs into a single conclusion.

### `/audit-new-source`

A wrapper around `source-implementation-reviewer` agent. Takes a
source-directory path and produces the structured-list output. The
agent already exists; the workflow is just a discoverable entry
point.

### `/redaction-add-rule`

A guided rule-addition flow: (1) take a sample secret, (2) propose a
narrow regex, (3) audit against `PRESERVED_TOKENS`, (4) generate the
patch + test fixture. Lives between `add-source-parser` skill and a
purely manual edit.

## What does NOT belong as a workflow here

- "Run the tests" — that's `bun run test:cov`. A workflow that just
  shells out adds nothing.
- "Bump the version" — that's `bun run release`. Manual bumping is
  forbidden (`ai/rules/process/calver-version-only-via-script.md`).
- "Format the code" — `bun run format`. Pre-commit hook covers it.
- Anything that touches `buffer.db` directly — that violates
  `ai/rules/services/no-direct-sqlite-outside-buffer.md`.

## Mapper note

Per `ai/README.md`, workflows are SKIPPED for codex. Other tools get
the workflow as a slash command. If a workflow is added, the mapper
output goes to `.claude/commands/`, `.gemini/commands/`,
`.cursor/commands/`, and `.agent/workflows/` automatically. Do not
hand-author the per-tool files.

[source: ai/README.md, ai/skills/, ai/agents/, ai/mapper/emitters/workflows.ts]
