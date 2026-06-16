---
name: "Parser Version Bump Enforcement"
description: "Enforces bumping agentSchemaVersion whenever a source parser's emitted record shape changes."
activation: "contextual"
scenarios: ["Adding or removing a property in emitted record JSON", "Changing a property value type in a parser", "Modifying parser record interpretation or filter logic"]
globs: ["src/**/*.ts", "**/*.ts"]
---

# Parser Version Bump Rule


**Any change to a source parser's emitted record shape — adding a field,
removing a field, renaming, changing a value type, or changing a
filter's accept/reject decision — requires bumping the parser's
`agentSchemaVersion` output.**

`agentSchemaVersion` flows through every `AgentCallRecord` the parser
emits and lands in the `agent_schema_version` column of `upload_batches`
and in the DTO's `agent_schema_version` field
(under the `RawRecordDTO` interface in `contract.types.ts`). The server uses it to partition records for
schema-aware downstream processing. If the shape changes without a
version bump, downstream consumers cannot distinguish the new shape
from the old, and historical records become un-replayable.

## What counts as a "shape change"

Any of:

- Adding or removing a property in the emitted record JSON.
- Changing a property's value type (string → number, object → array,
  scalar → nullable).
- Renaming a property key.
- Changing how a value is computed (e.g. wall-clock timestamp →
  monotonic offset) even if the type is identical.
- Changing the per-source filter's accept/reject decision boundary
  (e.g. `isDialogueRecord` now accepts a previously-rejected `type`).
- Reordering rules in a way that changes the emitted output for at
  least one input fixture.

What does NOT count:
- Pure refactoring with no fixture-output diff.
- Fixing a bug that produced demonstrably malformed output (the broken
  output was never valid; treat as a hotfix, not a schema bump).
- Performance optimization that produces byte-identical output.

## How parser version is set per source

Each `collect.ts` extracts `agentSchemaVersion` from the source itself
where possible:

- `claude-code`: `extractAgentSchemaVersion(redactedFullText)` parses
  `version` / `message.version` from the JSONL itself
  (`sources/claude-code/collect.ts:278`).
- `cursor`: `extractAgentSchemaVersion(kvRows)` reads the version key
  from the sqlite KV pairs (`sources/cursor/collect.ts:140`).
- `codex`: parsed from the rollout/state file format.

When the source's own version string is unavailable, a hard-coded
fallback in the parser's constants file is used. **That fallback string
is what you bump** when changing the gateway's interpretation of the
source's output.

## Why this is in `sources/` rules, not `process/`

This is a per-source contract, not a release-engineering process. A
maintainer touching `sources/claude-code/collect.ts` must understand
that changing the emitted dialogue shape affects every claude-code
record going forward and must coordinate the bump in the same commit.

## Audit trail

When bumping a parser version, add a short note (1-2 lines) in the
PR description describing the shape diff. Server-side, the new
`agent_schema_version` value should be added to the schema registry
so downstream consumers can fan out on it.

## Related rules

- `ai/rules/services/no-direct-sqlite-outside-buffer.md` — schema
  changes to `buffer.db` are *additive* only, with column-exists
  guards. Parser version is the analogue for emitted record schemas.
- `ai/rules/sources/sources.md` — `SOURCE_VARIANTS` must include any
  new variant before `validateRawRecordDTO` will accept it.

[source: src/sources/claude-code/collect.ts, src/sources/cursor/collect.ts, src/services/contract/contract.types.ts]
