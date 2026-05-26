# Skill Rationale

Three skills live in `ai/skills/`. Each maps a recurring multi-file task
to a discoverable named procedure with code references. This file
documents *when* each one applies and *why* it was carved out as a
skill rather than left as inline knowledge.

A skill here is a `SKILL.md` with YAML frontmatter (`name`,
`description`) plus optional supporting files in the same directory.
The mapper distributes the whole directory to per-tool skill folders.

## `add-source-parser`

**When**: any request to capture a new coding-agent's session files
("add support for X CLI", "capture Y's session DB"). The skill
front-loads the ten-step scaffold that adding a source requires.

**Why a skill, not knowledge**: adding a source touches six modules
in a fixed order:
1. `src/sources/<agent>/` — new directory with five files
2. `src/services/contract/contract.constants.ts` — `SOURCE_VARIANTS` entry
3. `src/services/polling/default-sources.ts` — registration
4. `src/services/polling/poll-worker.ts` — worker handler
5. Tests under `src/sources/<agent>/tests/`
6. `validateRawRecordDTO` coverage

Missing any one step causes a silent runtime failure — the DTO is
rejected by the on-device validator and the upload never happens. A
skill is the right shape because the order is fixed and the failure
mode is a multi-file integration gap, not a code-style issue.

**Key files referenced**: `src/sources/<agent>/discover.ts`,
`collect.ts`, `index.ts`, `<agent>.constants.ts`; `contract.constants.ts`;
`polling/default-sources.ts`, `poll-worker.ts`.

**Common pitfalls listed in the skill**: `**/*.jsonl` glob; missing
`SOURCE_VARIANTS`; missing `consecutive_errors` tracking; missing
VACUUM detect; not using `snapshotSqlite`; using `any`.

## `audit-sqlite-usage`

**When**: touching any file under `src/core/io/sqlite/` or any source
collector that opens a sqlite DB; debugging sqlite-related test
failures on Windows.

**Why a skill, not knowledge**: bun:sqlite has six known correctness
hazards that have all surfaced as bugs at least once in this repo:
1. `?immutable=1` URI flag works on macOS but fails on Linux/Windows
2. `node:fs/promises.rm` for teardown produces EBUSY on Windows
3. Short `afterEach` timeout (5 s) is too tight for sqlite teardown
4. Real SQL execution in unit tests defeats DI
5. Missing double-attempt open pattern (try `openReadOnly`, fallback
   to `{ immutable: true }`) breaks on some host states
6. Forgetting `rmRecursive`'s `Bun.gc(true)` retry loop

These are crosscutting; an audit-style skill that lists them all is
more useful than scattering them across per-file knowledge.

**Key files referenced**: `src/core/io/sqlite/open.ts`,
`src/core/io/fs/rm-recursive.ts`, `src/services/buffer/db.ts`,
`src/sources/cursor/`, `src/sources/codex/`.

## `redaction-validator`

**When**: adding or modifying a rule under
`src/services/redaction/rules/`; debugging a false-positive
redaction report.

**Why a skill, not knowledge**: the redaction system has a
non-obvious invariant — `applyRedaction` is a single-pass walk over
`ALL_RULES` in declaration order, and `auditRulesAgainstFixtures` is
a CI gate that fails if any rule matches any `PRESERVED_TOKENS`
fixture. A new rule must:
1. Be added to a category file under `rules/`, not stand-alone.
2. Use a literal-string `replacement` (no callback variant).
3. Have a global `g` flag on the regex.
4. Pass `auditRulesAgainstFixtures`.
5. Not match `source_path`, `sessionId`, `rowid`, or any other key in
   `PRESERVED_TOKENS`.

A skill is appropriate because a rule that violates any of these
*will* deploy without local errors and only break in the
fuzz-corpus self-test on CI.

**Key files referenced**:
`src/services/redaction/rules/index.ts`,
`src/services/redaction/preserve.ts`,
`src/services/redaction/redaction.ts`,
`src/services/redaction/tests/`.

## What does NOT belong as a skill

- Pure rules ("always use bun:sqlite via the buffer API"). Those live
  in `ai/rules/`.
- One-off troubleshooting ("the daemon won't upload"). Those are
  runbooks under `ai/knowledge/runbooks/`.
- Code style ("no `any`"). That's in `ai/rules/modules/typescript.md`.
- High-level architecture ("how does the capture cycle work"). That's
  knowledge under `ai/knowledge/architecture/`.

The litmus test: a skill is invoked **at the point of action** to
walk the contributor through a multi-step procedure. If it's
something you read once and absorb, it's knowledge or a rule.

[source: ai/skills/audit-sqlite-usage/SKILL.md, ai/skills/add-source-parser/SKILL.md, ai/skills/redaction-validator/SKILL.md, ai/README.md]
