# `ai/mapper` — How the AI artifact mapping works

This document is the **single source of truth** for how the `ai/` folder maps to per-tool artifact files. Read this first before adding a new artifact type, a new LLM provider, or modifying an existing emitter. **This document is also designed to be given to an LLM verbatim** to help a developer add new artifacts — every claim is concrete and grounded.

---

## 1. Purpose

The `ai/` folder is a **pure mapper** for AI coding agent artifacts. You author your project's AI artifacts (rules, skills, agents, workflows, tools, knowledge, main guide doc) ONCE under `ai/` in a tool-agnostic format, and the mapper distributes them into each enabled LLM provider's native location and format.

This solves the **artifact fragmentation problem**: Claude Code wants `CLAUDE.md` + `.claude/skills/`, Codex wants `AGENTS.md` + `.agents/skills/`, Gemini wants `GEMINI.md` + `.gemini/skills/`, Cursor wants `AGENTS.md` + `.cursor/skills/`, Antigravity wants `.agent/AGENTS.md` + `.agent/skills/`. Without a mapper, you maintain N parallel sets of files. With this mapper, you maintain ONE set under `ai/`.

**Portability:** drop the `ai/mapper/` folder + an empty `ai/` content scaffold into any new repo, fill in the categories, and the mapper works the same way. The mapper code is repo-agnostic.

---

## 2. The mapping table (the spec)

| `ai/` source                              | Claude Code                                                | Codex CLI                                                                          | Gemini CLI                                                  | Cursor                                                                       | Antigravity                                                                                                                  |
| ----------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `AGENTS.md`                               | → root `CLAUDE.md`                                         | → root `AGENTS.md`                                                                 | → root `GEMINI.md`                                          | → root `AGENTS.md` (same file Codex reads)                                   | → `.agent/AGENTS.md`                                                                                                         |
| `rules/<n>.md`                            | → `.claude/rules/<n>.md` (native folder; auto-loaded)      | → `.codex/rules/<n>.md` (LLM reads manually via Read tool)                         | → `.gemini/rules/<n>.md` (LLM reads manually via Read tool) | → `.cursor/rules/<n>.mdc` with `alwaysApply: true` frontmatter (auto-loaded) | → `.agent/rules/<n>.md` (native folder; auto-loaded)                                                                         |
| `knowledge/<n>.md`                        | → `.claude/knowledge/<n>.md` + indexed in `CLAUDE.md`      | → `.codex/knowledge/<n>.md` + indexed in `AGENTS.md`                               | → `.gemini/knowledge/<n>.md` + indexed in `GEMINI.md`       | → `.cursor/knowledge/<n>.md` + indexed in `AGENTS.md`                        | → `.agent/knowledge/<n>.md` + indexed in `.agent/AGENTS.md`                                                                  |
| `skills/<n>/SKILL.md` (+ folder contents) | → `.claude/skills/<n>/`                                    | → `.agents/skills/<n>/` ⚠️ **PLURAL** `.agents` (root-level, not `.codex/skills/`) | → `.gemini/skills/<n>/`                                     | → `.cursor/skills/<n>/`                                                      | → `.agent/skills/<n>/`                                                                                                       |
| `workflows/<n>.md`                        | → `.claude/commands/<n>.md` (Claude calls them "commands") | **SKIP** (Codex custom prompts deprecated, no project scope)                       | → `.gemini/commands/<n>.toml` (TOML translation)            | → `.cursor/commands/<n>.md` (plain md, no frontmatter)                       | → `.agent/workflows/<n>.md` (same name as `ai/`)                                                                             |
| `agents/<n>.md`                           | → `.claude/agents/<n>.md` (passthrough md+frontmatter)     | → `.codex/agents/<n>.toml` (TOML translation)                                      | → `.gemini/agents/<n>.md` (passthrough)                     | → `.cursor/agents/<n>.md` (passthrough)                                      | **SKIP** (no user-authored subagent format verified; `.agent/agents/` doesn't exist in Antigravity binary string references) |
| `tools/*` (recursive)                     | → `.claude/tools/*`                                        | → `.codex/tools/*`                                                                 | → `.gemini/tools/*`                                         | → `.cursor/tools/*`                                                          | → `.agent/tools/*`                                                                                                           |

### Why these specific paths

Every cell in this table was verified against:

- Official docs URLs (Claude `code.claude.com/docs/en`, Codex `developers.openai.com/codex`, Gemini bundled docs at `node_modules/@google/gemini-cli/bundle/docs`, Cursor `cursor.com/docs`)
- Binary string dumps (`strings /opt/homebrew/Caskroom/codex/.../codex-aarch64-apple-darwin`, `strings ~/.local/bin/agy`)
- Filesystem inspection on a working install (e.g., `ls ~/.claude/skills/`, `ls ~/.cursor/skills-cursor/`)

The full cross-tool research with citations is at `~/memory-sync/ai-folder-research/` (per-tool reports) and `/tmp/cross-tool-mappings.md` (cross-tool comparison). **Do not change the mapping table without re-verifying the affected tool's docs/binary** — empirically these are the correct paths as of May 2026.

### Things the mapper deliberately skips

- **MCP server distribution** — manage MCP at the user-global level; per-repo MCP rarely justifies clutter.
- **Hooks** — per-tool event names diverge wildly and rapidly evolve; not worth abstracting.
- **Scoped/nested rules** — each tool handles scope its own way (Cursor `globs:`, Claude rule cascade, Codex hierarchical AGENTS.md). Just emit unscoped rules and let each tool's main doc + native rules folder do the right thing.
- **Antigravity `agents/`** — no `.agent/agents/` directory was found in any tested repo, and the Antigravity binary does not reference a user-authored subagent format. Until verified, the mapper skips Antigravity for the agents category.
- **Codex `workflows/`** — Codex custom prompts (`~/.codex/prompts/*.md`) are user-only and officially deprecated in favor of Skills. The mapper does not emit project-scoped workflows for Codex.

If you need any of these, add an emitter (see §10).

---

## 3. The `ai/` folder schema

```
ai/
├── AGENTS.md                # required: main guide doc (project preamble, overview, primary instructions)
├── README.md                # contributor guide for this folder (separate from mapper README)
├── mapper.config.toml       # mapper configuration (which tools enabled, paths)
│
├── rules/                   # one file per topic; plain markdown body, no frontmatter
│   ├── typescript.md
│   ├── testing.md
│   └── ...
│
├── knowledge/               # one file per topic; plain markdown body
│   ├── architecture.md
│   ├── conventions.md
│   └── ...
│
├── skills/                  # cross-tool SKILL.md packages
│   ├── audit-tests/
│   │   ├── SKILL.md         # required; YAML frontmatter (name, description)
│   │   ├── references/      # optional; copied verbatim
│   │   └── scripts/         # optional; copied verbatim
│   └── ...
│
├── workflows/               # slash-command prompt templates
│   ├── ship.md              # frontmatter: description; body is the prompt
│   ├── audit.md
│   └── ...
│
├── agents/                  # named agent personas
│   ├── code-reviewer.md     # frontmatter: name, description, tools, model; body is the system prompt
│   ├── test-runner.md
│   └── ...
│
├── tools/                   # shared helper scripts that workflows/skills/agents can call
│   ├── confirm-push.sh
│   ├── coverage-check.ts
│   └── ...
│
├── mapper/                  # the distributor (this folder)
│   ├── README.md            # this file
│   ├── index.ts             # CLI entry
│   ├── config.ts
│   ├── loader.ts
│   ├── frontmatter.ts
│   ├── manifest.ts
│   ├── safe-fs.ts
│   ├── check.ts
│   ├── emitters/
│   │   ├── root.ts          # AGENTS.md / CLAUDE.md / GEMINI.md / .agent/AGENTS.md (lean — no inlined knowledge)
│   │   ├── rules.ts         # all 5 tools' rules/ folders
│   │   ├── knowledge.ts     # all 5 tools' knowledge/ folders (one file per topic)
│   │   ├── skills.ts        # all 5 tools (Codex gets PLURAL .agents/skills/)
│   │   ├── agents.ts        # 4 tools (skip Antigravity)
│   │   ├── workflows.ts     # 4 tools (skip Codex)
│   │   └── tools.ts         # all 5 tools
│   ├── translators/
│   │   ├── codex-toml.ts    # agents/<n>.md → .codex/agents/<n>.toml
│   │   └── gemini-toml.ts   # workflows/<n>.md → .gemini/commands/<n>.toml
│   └── tests/
│       └── ...
│
└── .mapper-manifest.json    # generated; lists every emitted file with hash (for safe-wipe)
```

---

## 4. Per-category authoring guide

### 4.1 `ai/AGENTS.md`

The main guide doc. Plain markdown. No frontmatter required. **Do not mention specific LLM names** (no "you are Claude", no "use Gemini's @import syntax") — keep it generic. Per-LLM tweaks are not currently a feature.

Example:

```markdown
# proxai_gateway

Bun-native gateway. Runs as a managed background service. See knowledge/ and rules/ for details.
```

### 4.2 `ai/rules/*.md`

One rule topic per file. **Plain markdown — no frontmatter.** The filename (without `.md`) becomes the rule's identifier when emitted to native rules folders.

Example `ai/rules/typescript.md`:

```markdown
# TypeScript rules

- Use `unknown` + type guards for unknown boundary shapes.
- No `any` types in source or tests.
- ...
```

After mapping:

- Claude reads `.claude/rules/typescript.md` directly (auto-loaded from the native rules folder)
- Cursor reads `.cursor/rules/typescript.mdc` with auto-added frontmatter (auto-loaded):

  ```
  ---
  description: typescript
  alwaysApply: true
  ---

  # TypeScript rules
  - ...
  ```

- Antigravity reads `.agent/rules/typescript.md` directly (auto-loaded from the native rules folder)
- Codex reads `.codex/rules/typescript.md` — **not** auto-loaded; the orchestration map in `AGENTS.md` directs the LLM to read each file via the Read tool
- Gemini reads `.gemini/rules/typescript.md` — **not** auto-loaded; the orchestration map in `GEMINI.md` directs the LLM to read each file via the Read tool

### 4.3 `ai/knowledge/*.md`

One knowledge topic per file. **Plain markdown — no frontmatter.** Use this for niche project context: code-specific gotchas, design-system specifics, product-decision rationale that drives technical choices. **Not for general docs** — if the repo has a `docs/` folder, broader documentation belongs there.

The first non-empty line (typically the H1) is auto-extracted as the topic description shown in each tool's knowledge index. Keep H1s tight and descriptive.

After mapping each knowledge file:

- Is written verbatim to `<tool_dir>/knowledge/<subpath>.md` for every enabled tool. Subdir nesting under `ai/knowledge/` is preserved (e.g. `ai/knowledge/api/route-map.md` → `.claude/knowledge/api/route-map.md`).
- Is referenced from every tool's root doc inside a `## Domain knowledge index` table — one row per file pointing at the on-disk path with its H1 as the topic.

**Knowledge bodies are NOT inlined into root docs.** Before this split (mapper v2.0), every root doc carried the full concatenation of all knowledge bodies — 1M+ chars in repos with non-trivial knowledge trees, which froze Claude Code on cold start (~2 min hang). The split keeps root docs lean and lets agents Read only the topics relevant to the current task. **Do not** restore inlining; if a knowledge body needs to be unconditionally loaded, promote it to a rule instead.

### 4.4 `ai/skills/<name>/SKILL.md` (+ folder)

Cross-tool SKILL.md package. Required frontmatter:

```markdown
---
name: audit-tests
description: Audits the test suite against the rules in tests.md
---

# Audit Tests

When to use: …
Steps: …
```

The whole folder is copied verbatim to each tool's skills dir. You can include `references/`, `scripts/`, sub-folders — they all come along.

### 4.5 `ai/workflows/<n>.md`

Slash-command prompt templates. Optional frontmatter `description`. Body is the prompt template invoked via `/<basename>`.

Example `ai/workflows/audit.md`:

```markdown
---
description: Run an audit
---

Audit the codebase per AGENTS.md. Report findings.
```

After mapping:

- Claude reads `.claude/commands/audit.md` (passthrough)
- Cursor reads `.cursor/commands/audit.md` (passthrough)
- Antigravity reads `.agent/workflows/audit.md` (passthrough, same name as `ai/`)
- Gemini reads `.gemini/commands/audit.toml` (TOML translation):
  ```toml
  description = "Run an audit"
  prompt = """
  Audit the codebase per AGENTS.md. Report findings.
  """
  ```
- Codex: not emitted (deprecated)

### 4.6 `ai/agents/<n>.md`

Named agent personas. Frontmatter:

```markdown
---
name: code-reviewer
description: Reviews changes for correctness and project-rule compliance
tools: ['Read', 'Grep', 'Bash']
model: claude-opus-4-7
---

You are a senior code reviewer for this codebase. Review the given diff for:

1. Correctness bugs
   ...
```

Supported frontmatter fields:

- `name` (string, required) — the agent's identifier
- `description` (string, required) — when to use it
- `tools` (string array, optional) — allowed tools
- `model` (string, optional) — preferred model

After mapping:

- Claude, Cursor, Gemini: receive the file as-is (md + frontmatter)
- Codex: translated to TOML:
  ```toml
  name = "code-reviewer"
  description = "Reviews changes for correctness and project-rule compliance"
  tools = ["Read", "Grep", "Bash"]
  model = "claude-opus-4-7"
  instructions = """
  You are a senior code reviewer for this codebase. Review the given diff for:
  1. Correctness bugs
  ...
  """
  ```
- Antigravity: **skipped** (no verified user-authored subagent format)

### 4.7 `ai/tools/`

Shared helper scripts (bash, python, typescript — any extension). Called by workflows, skills, or agents.

Copied recursively to each enabled tool's `tools/` subdir. So `ai/tools/helper.sh` becomes `.claude/tools/helper.sh`, `.codex/tools/helper.sh`, etc.

Reference from skills/workflows via a tool-relative path like `tools/helper.sh` (where the working directory is the tool's dir).

---

## 5. How the mapper works (architecture)

### 5.1 Pipeline

`bun run ai/mapper/index.ts` (or `bun run ai:sync` — same thing, see §5.5) runs this sequence:

1. **Compute source-tree hash** (`source-hash.ts`) — recursively hash every non-dotfile under `ai/` (paths + contents). Cheap (sha256 over ~200 small markdown files).
2. **Load existing manifest** (`manifest.ts`) — read `ai/.mapper-manifest.json` if present
3. **Fast-skip check**: if the manifest's stored `sourceHash` matches the current source hash AND every emitted path in the manifest still exists on disk, exit early with "up to date" — no I/O beyond stat calls. (Bypass with `--force`.)
4. **Load config** (`config.ts`) — read `ai/mapper.config.toml` into `MapperConfig`
5. **Load tree** (`loader.ts`) — walk `ai/` and build an `AiTree` (preamble + rules[] + knowledge[] + skills[] + workflows[] + agents[] + tools)
6. **Emit all categories** in order: root → rules → skills → agents → workflows → tools (each emitter records what it wrote into a fresh manifest)
7. **Safe-wipe stale files** — delete files that were in the OLD manifest but NOT in the new one
8. **Save fresh manifest** — write the new `.mapper-manifest.json` with the source hash + all currently-emitted file paths + content hashes

### 5.2 Why safe-wipe via manifest

If you delete `ai/skills/foo/` and re-run, every `.<tool>/skills/foo/` directory should disappear. The manifest tracks every file we ever wrote, so when the new run doesn't emit `foo`, we know to delete the previously-emitted copies in every tool's dir. **Without the manifest, stale files would accumulate.**

Critically: the mapper ONLY deletes files it previously wrote (per the old manifest). It will NOT delete files in `.<tool>/` directories that you added by hand (e.g., `.claude/settings.local.json`).

### 5.3 Atomic writes

Every emitter uses `writeFileAtomic(path, content)` from `safe-fs.ts` (writes to a temp file, then renames). This means a half-finished sync never leaves you with truncated files.

### 5.4 The `--check` mode

`bun run ai/mapper/index.ts --check` runs the FULL pipeline into a throwaway temp directory, then diffs the would-be manifest against the on-disk manifest. Exits 1 if there's drift. Useful as a pre-commit hook or local sanity check. Not meant for CI (the manifest is gitignored, so a fresh CI checkout has no baseline). `--check` is independent of the fast-skip path — it always re-emits.

### 5.5 The fast-skip path and `ai:sync`

The repo exposes `bun run ai:sync` as a thin alias for `bun run ai/mapper/index.ts`. It is also chained into the four local-dev startup commands — `dev`, `start`, `start:dev`, `start:debug` — so a developer never has to remember to regenerate the per-tool artifacts after pulling new `ai/` content. The fast-skip path keeps the cost negligible: when nothing has changed since the last sync, `ai:sync` prints one line (`up to date — N emitted files unchanged since last sync (skip)`) and exits in ~50ms.

How the skip decides:

- **Source hash equal AND every manifest path exists** → skip (no emit, no manifest write).
- **Source hash equal BUT a generated file is missing** (e.g. someone ran `rm -rf .claude` or `git clean -fdx`) → re-sync. The diagnostic line names the first missing file so the cause is obvious.
- **Source hash differs** → re-sync (one or more files under `ai/` changed since last successful sync).
- **`--force` flag present** → always re-sync, even if source matches.

`start:prod` (`node dist/main`) is **not** chained — production runs from the built `dist/`, where the mapper is not present and the per-tool artifacts are irrelevant. CI builds and Docker images should not invoke `ai:sync` either.

---

## 6. Per-emitter details

### 6.1 `emitters/root.ts`

Emits the main guide doc for each tool. Composition (pure index — neither rule bodies nor knowledge bodies are inlined):

```
<ai/AGENTS.md content>

<repo file tree>

<orchestration map — points to that tool's rules + knowledge folders>

<Extending the AI memory section>

<Domain knowledge index — one row per ai/knowledge/*.md file with its on-disk path and H1>
```

Main docs contain no rule content and no knowledge content. They only tell the LLM where to find both. This keeps every main doc under ~25 KB (was ~1.3 MB before knowledge was split out) and avoids the cold-start hang Claude Code suffered when forced to ingest the entire knowledge corpus at session start.

The root emitter also:

- Auto-detects whether the repo has a `docs/` folder. If yes, inserts a "Project documentation" section pointing the LLM there.
- Injects a uniform "Extending the AI memory" section into every main doc — instructions for the LLM to enhance `ai/` (not the per-tool dirs) when learning new things.
- Extracts the first non-empty line of every `ai/knowledge/*.md` (typically the H1) as the topic description in the knowledge index. Falls back to basename if the body is empty.

Destinations:

- `cfg.tools.claude` → `<root>/CLAUDE.md`
- `cfg.tools.codex` or `cfg.tools.cursor` → `<root>/AGENTS.md` (single file — both read it)
- `cfg.tools.gemini` → `<root>/GEMINI.md`
- `cfg.tools.antigravity` → `<root>/.agent/AGENTS.md`

### 6.2 `emitters/rules.ts`

Per-rule file emission to all 5 tool rules folders.

For each `ai/rules/<n>.md`:

- `cfg.tools.claude` → `.claude/rules/<n>.md` (verbatim — Claude auto-loads this folder)
- `cfg.tools.cursor` → `.cursor/rules/<n>.mdc` with auto-added frontmatter (Cursor auto-loads this folder):

  ```
  ---
  description: <n>
  alwaysApply: true
  ---

  <body>
  ```

- `cfg.tools.codex` → `.codex/rules/<n>.md` (verbatim — LLM reads manually via Read tool)
- `cfg.tools.gemini` → `.gemini/rules/<n>.md` (verbatim — LLM reads manually via Read tool)
- `cfg.tools.antigravity` → `.agent/rules/<n>.md` (verbatim — Antigravity auto-loads this folder)

### 6.3 `emitters/knowledge.ts`

Per-knowledge file emission. Mirrors the rules-emitter shape: each enabled tool gets its own `<tool_dir>/knowledge/<subpath>.md` containing the body verbatim. Subdir nesting under `ai/knowledge/` is preserved (e.g. `ai/knowledge/api/route-map.md` → `.claude/knowledge/api/route-map.md`).

For each `ai/knowledge/<n>.md`:

- `cfg.tools.claude` → `.claude/knowledge/<n>.md`
- `cfg.tools.cursor` → `.cursor/knowledge/<n>.md`
- `cfg.tools.codex` → `.codex/knowledge/<n>.md`
- `cfg.tools.gemini` → `.gemini/knowledge/<n>.md`
- `cfg.tools.antigravity` → `.agent/knowledge/<n>.md`

No tool auto-loads its knowledge folder — every root doc carries a `## Domain knowledge index` table pointing at these files, and the LLM uses the Read tool on the relevant entries when a task touches the topic. This split is what keeps root docs ~25 KB instead of ~1.3 MB. See `emitters/root.ts` for how the index is built.

### 6.4 `emitters/skills.ts`

For each `ai/skills/<n>/` folder, recursively copy to each enabled tool's skills dir.

Destinations:

- `cfg.tools.claude` → `<claudeDir>/skills/<n>/`
- `cfg.tools.codex` → `.agents/skills/<n>/` ⚠️ **PLURAL `.agents/` at root level, not `.codex/skills/`** (verified from Codex binary source path `codex-rs/core/src/skills.rs`)
- `cfg.tools.gemini` → `<geminiDir>/skills/<n>/`
- `cfg.tools.cursor` → `<cursorDir>/skills/<n>/`
- `cfg.tools.antigravity` → `<antigravityDir>/skills/<n>/`

### 6.5 `emitters/agents.ts`

Pass-through for most tools, TOML translation for Codex. Skip Antigravity.

For each `ai/agents/<n>.md`:

- `cfg.tools.claude` → `.claude/agents/<n>.md` (verbatim file content)
- `cfg.tools.cursor` → `.cursor/agents/<n>.md` (verbatim)
- `cfg.tools.gemini` → `.gemini/agents/<n>.md` (verbatim)
- `cfg.tools.codex` → `.codex/agents/<n>.toml` (translated via `translators/codex-toml.ts`)
- Antigravity: not emitted

### 6.6 `emitters/workflows.ts`

Pass-through for most, TOML for Gemini, skip Codex. Different filename for Antigravity.

For each `ai/workflows/<n>.md`:

- `cfg.tools.claude` → `.claude/commands/<n>.md` (verbatim)
- `cfg.tools.cursor` → `.cursor/commands/<n>.md` (verbatim)
- `cfg.tools.gemini` → `.gemini/commands/<n>.toml` (translated via `translators/gemini-toml.ts`)
- `cfg.tools.antigravity` → `.agent/workflows/<n>.md` (verbatim, but folder is called `workflows/` not `commands/`)
- Codex: not emitted

### 6.7 `emitters/tools.ts`

Copies `ai/tools/` recursively to each enabled tool's `tools/` subdir. No translation, no per-tool variations.

---

## 7. Translators

### 7.1 `translators/codex-toml.ts`

Converts an `ai/agents/<n>.md` (markdown body + YAML frontmatter) into a Codex-compatible TOML file.

Output structure:

```toml
name = "<from frontmatter.name>"
description = "<from frontmatter.description>"
tools = ["<from frontmatter.tools array>"]      # only emitted if non-empty
model = "<from frontmatter.model>"              # only emitted if present
instructions = """
<markdown body verbatim>
"""
```

String escaping: backslashes and double-quotes are escaped via `\\` and `\"`. Triple quotes inside the body are escaped as `\"\"\"`.

### 7.2 `translators/gemini-toml.ts`

Converts an `ai/workflows/<n>.md` into a Gemini-compatible TOML file.

Output structure:

```toml
description = "<from frontmatter.description>"
prompt = """
<markdown body verbatim>
"""
```

Same string-escaping rules as the Codex translator.

---

## 8. Configuration (`ai/mapper.config.toml`)

```toml
schema_version = 2

[tools]
claude = true
codex = true
cursor = true
gemini = true
antigravity = true

[paths]
claude_dir = ".claude"
cursor_dir = ".cursor"
codex_dir = ".codex"
gemini_dir = ".gemini"
antigravity_dir = ".agent"
```

- `schema_version` — bumped when the config schema changes. Mapper rejects unrecognized versions.
- `[tools]` — disable any tool by setting to `false` (skips all its emissions; also triggers safe-wipe of previously-emitted files for that tool).
- `[paths]` — override the per-tool directory names if needed (rarely useful — the defaults are the canonical paths each tool reads from).

---

## 9. Manifest (`ai/.mapper-manifest.json`)

Gitignored. Tracks every file the mapper has emitted, with content hashes.

Schema:

```json
{
  "version": 1,
  "generatedAt": "2026-05-23T19:37:00.000Z",
  "files": [
    { "path": "AGENTS.md", "hash": "a1b2c3..." },
    { "path": "CLAUDE.md", "hash": "a1b2c3..." },
    { "path": ".claude/rules/typescript.md", "hash": "..." },
    ...
  ]
}
```

Paths are relative to the repo root.

The manifest enables:

- **Safe-wipe:** delete files that were emitted previously but aren't in the new run.
- **Drift detection (`--check`):** diff expected vs current state without rewriting.

Do not edit by hand. Regenerated on every `bun run ai/mapper/index.ts`.

---

## 10. How to add a new artifact category

Use this checklist when introducing a new top-level concept under `ai/`.

1. **Decide if it's truly universal.** Does every (or at least 2+) supported LLM have a native equivalent? If only one tool has it, just put it in that tool's per-repo config; don't pollute `ai/`.

2. **Verify each tool's native location and format.** Run `strings <binary>`, read official docs, inspect a working install. Add citations to a new row in the mapping table (§2).

3. **Add the loader field.** Edit `ai/mapper/loader.ts`:
   - Define a new TypeScript interface (`MyArtifact`, etc.)
   - Add a field to `AiTree` (e.g., `myartifacts: MyArtifact[]`)
   - In `loadTree()`, read the new `ai/<category>/` folder

4. **Create an emitter.** New file `ai/mapper/emitters/<category>.ts`. Pattern:

   ```typescript
   import { join } from "node:path";
   import { writeFileAtomic, hashOf } from "../safe-fs";
   import type { AiTree } from "../loader";
   import type { MapperConfig } from "../config";
   import type { Manifest } from "../manifest";

   export async function emit<Category>(
     repoRoot: string,
     tree: AiTree,
     cfg: MapperConfig,
     mani: Manifest,
   ): Promise<void> {
     for (const item of tree.<category>) {
       if (cfg.tools.<tool>) {
         const rel = join(cfg.paths.<tool>Dir, "...", `${item.basename}.<ext>`);
         const content = /* compose per-tool */;
         await writeFileAtomic(join(repoRoot, rel), content);
         mani.recordEmit(rel, hashOf(content));
       }
       // ... other tools
     }
   }
   ```

5. **Wire into `index.ts` and `check.ts`.** Add the emitter call to both files in the right order (typically after dependent emitters).

6. **Add a translator** if any tool needs a different format. New file under `translators/`.

7. **Write tests.** `ai/mapper/tests/emit-<category>.spec.ts`. Use the fixture at `tests/fixtures/minimal-ai/` (add a sample of the new category there too).

8. **Update the mapping table in this README and in `ai/README.md`.**

9. **Run `bun test ai/mapper/tests/` and `bun run ai/mapper/index.ts` to verify end-to-end.**

---

## 11. How to add a new LLM provider

1. **Research the new tool's artifact conventions.** Where does it read its main guide doc? Skills? Agents? Commands? Use the same proof rigor as §2 (docs URL + binary string + filesystem inspection on a working install).

2. **Update `MapperConfig`** in `config.ts`:
   - Add a new key to `tools` (e.g., `newtool: boolean`)
   - Add a new key to `paths` (e.g., `newtoolDir: string`)

3. **Update `mapper.config.toml`:**

   ```toml
   [tools]
   newtool = true

   [paths]
   newtool_dir = ".newtool"
   ```

4. **Extend every emitter to handle the new tool.** Each emitter has a series of `if (cfg.tools.<tool>) { ... }` blocks. Add one for the new tool.

5. **If the new tool uses a non-markdown format** (e.g., TOML, JSON), add a translator under `translators/`.

6. **Update tests.** Each emit-\*.spec.ts test should assert the new tool's output.

7. **Update both READMEs.**

---

## 12. Modifying an existing artifact's frontmatter schema

`frontmatter.ts` parses a deliberate subset of YAML (string, bool, number, inline string array). When adding a new field type:

- **String, bool, number, string array:** supported. Just use the field in the new emitter.
- **Anything else (block scalars, nested maps, multi-line arrays):** the parser will throw. Either keep your frontmatter to the supported subset, or extend `frontmatter.ts` (carefully — keep the parser minimal).

When changing semantics (e.g., renaming a required field), bump `schema_version` in `mapper.config.toml` and add a validation check in `config.ts`.

---

## 13. Common pitfalls

| Pitfall                                                         | Why it happens                                                                                                                                                                                           | Fix                                                                                                                                                                                                                                               |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stray `**/` directories appear under `src/`                     | An old version of the mapper emitted nested AGENTS.md from glob-style scope frontmatter; or a rule's `scope:` was set to a glob                                                                          | Delete the stray dirs (`rm -rf src/'**'`). Current mapper has a guard against glob-style scopes — `emit-nested-rules` was removed in v2 entirely.                                                                                                 |
| `.codex/skills/` empty after sync                               | Codex skills go to `.agents/skills/` (PLURAL, root level), not `.codex/skills/`. This is intentional.                                                                                                    | Look in `.agents/skills/` instead.                                                                                                                                                                                                                |
| Cursor doesn't pick up rules                                    | Did you add the `description` and `alwaysApply: true` frontmatter? `.mdc` files NEED them. The rules emitter does this automatically — verify the generated `.cursor/rules/<n>.mdc` has the frontmatter. | If the emitter is broken, re-run sync.                                                                                                                                                                                                            |
| `bun run ai/mapper/index.ts` throws on `bun_native_TOML_import` | Bun version too old for native TOML import via `import x from "./x.toml" with { type: "toml" }` syntax                                                                                                   | Upgrade Bun (need ≥1.1). Check with `bun --version`.                                                                                                                                                                                              |
| Manifest references files I deleted by hand                     | Mapper safely re-emits them on next run; OR they get safe-wiped if not in the source tree anymore                                                                                                        | Re-run sync to reconcile.                                                                                                                                                                                                                         |
| Generated files showing up in `git status`                      | `.gitignore` is missing an entry for that path                                                                                                                                                           | Add to `.gitignore`. The standard entries for proxai-style ignored generated artifacts are: `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.claude/`, `.cursor/`, `.codex/`, `.gemini/`, `.agent/`, `.agents/`, `.mapper-manifest.json`, `**/AGENTS.md`. |
| `.claude/settings.local.json` got deleted                       | The safe-wipe deleted it because it was in the old manifest.                                                                                                                                             | It shouldn't have been in the manifest — the mapper never emits it. If this happens, file a bug. Restore from git or recreate.                                                                                                                    |

---

## 14. Why we chose these tradeoffs

- **No MCP distribution:** MCP servers belong in user-global config. The only per-repo MCP that matters is one pointing to a repo-specific resource (e.g., a local SQLite DB) — rare enough to manage by hand.
- **No hooks distribution:** Hook event names diverge wildly (`PreToolUse` vs `preToolUse` vs `pre_tool_use`) and change frequently (Claude 2.x renamed events). Maintaining the translation table isn't worth it for the value delivered.
- **Antigravity agents skipped:** No verified user-authored subagent format. We chose silence over fabrication.
- **Codex workflows skipped:** Project-scope custom prompts don't exist in Codex (only user-scope at `~/.codex/prompts/`, and even that is deprecated). Skills are Codex's preferred path forward.
- **Every tool gets a dedicated rules folder:** every enabled tool receives a `<tool-dir>/rules/<n>.*` file per rule topic. The main doc (CLAUDE.md / AGENTS.md / GEMINI.md / .agent/AGENTS.md) is purely orchestration — it tells the LLM where to find rules, not what the rules say. This avoids embedding large rule content in main docs while ensuring every tool can access all rules.
- **Auto-load vs manual-read distinction:** Claude, Cursor, and Antigravity natively auto-load their rules folders. Codex and Gemini do not — their orchestration maps explicitly instruct the LLM to read each file in their rules folder via the Read tool.

---

## 15. Cross-repo portability

To bootstrap the system in another repo:

1. Copy the entire `ai/` folder structure (including `ai/mapper/`) into the new repo.
2. Empty out the content folders (`ai/rules/*.md`, `ai/knowledge/*.md`, etc.) — keep the folders, drop the files.
3. Edit `ai/AGENTS.md` to describe the new repo.
4. Add to `.gitignore` (if you DON'T want the per-tool files committed):
   ```
   AGENTS.md
   CLAUDE.md
   GEMINI.md
   .claude/
   .cursor/
   .codex/
   .gemini/
   .agent/
   .agents/
   .mapper-manifest.json
   **/AGENTS.md
   ```
5. Run `bun run ai/mapper/index.ts`.

The mapper has no proxai_gateway-specific code. The only repo-specific things are the content under `ai/` and the `.gitignore` rules.

---

## 16. Testing

Run the full suite:

```bash
bun test ai/mapper/tests/
```

Test files:

- `frontmatter.spec.ts` — frontmatter parser unit tests
- `config.spec.ts` — mapper.config.toml loader
- `loader.spec.ts` — full tree loading against the fixture
- `manifest.spec.ts` — manifest read/write/diff
- `safe-fs.spec.ts` — atomic write + hash + recursive copy
- `codex-toml.spec.ts` — Codex agent TOML translator
- `gemini-toml.spec.ts` — Gemini workflow TOML translator
- `emit-root.spec.ts` — main guide doc emission per tool
- `emit-rules.spec.ts` — rules → .claude/rules/ + .cursor/rules/.mdc
- `emit-knowledge.spec.ts` — knowledge → `<tool_dir>/knowledge/<n>.md` for every tool
- `emit-skills.spec.ts` — skills replicated to all 5 tools (Codex `.agents/skills/`)
- `emit-agents.spec.ts` — agents to 4 tools (skip Antigravity)
- `emit-workflows.spec.ts` — workflows to 4 tools (skip Codex)
- `emit-tools.spec.ts` — tools dir copied to all 5 tool dirs
- `check.spec.ts` — drift detection
- `e2e.spec.ts` — full pipeline end-to-end

The fixture lives at `tests/fixtures/minimal-ai/` and contains a sample of each category for testing.

---

## 17. Quick reference for developers adding new artifacts

**TL;DR for an LLM:** A developer wants to add a new artifact to the project (e.g., a new rule, a new skill, a new agent, a new workflow). Here's the decision tree:

1. **Is it a directive (must-do / must-not-do)?** → Add a file under `ai/rules/`. Plain markdown, no frontmatter.

2. **Is it a fact / background / architecture / domain knowledge?** → Add under `ai/knowledge/`. Plain markdown.

3. **Is it a reusable, named procedure you want the AI to be able to invoke as a "skill"?** → Create `ai/skills/<name>/SKILL.md` (with YAML frontmatter `name`, `description`) and any supporting files in the same folder.

4. **Is it a prompt template you want to invoke via `/name`?** → Add `ai/workflows/<name>.md` with frontmatter `description` and the prompt as the body.

5. **Is it a named "persona" / specialized agent with restricted tools?** → Add `ai/agents/<name>.md` with frontmatter `name`, `description`, `tools`, `model`.

6. **Is it a helper script (bash, python, ts) that workflows/skills/agents will call?** → Drop it in `ai/tools/`. Reference from skills/workflows via `tools/<script>`.

7. **After adding any file, run `bun run ai/mapper/index.ts` to regenerate per-tool artifacts.** (Or run `bun run ai/mapper/index.ts --check` to verify no drift.)

8. **For commit:** if `ai/` is committed in your repo (e.g., private internal repos), just `git add ai/<your-file>`. If `ai/` is gitignored (e.g., open-source repos), nothing to commit — the system is local-only.

That's it.
