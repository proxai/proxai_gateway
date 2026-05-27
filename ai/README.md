# `ai/` — Single source of truth for AI coding agent artifacts

This folder is the canonical home for all AI agent configuration that this repo wants every tool (Claude Code, Cursor, Codex, Gemini CLI, Antigravity) to see. **Everything in `ai/` is committed to git.** All generated per-tool files (root `AGENTS.md`, `.claude/`, `.cursor/`, etc.) are gitignored — regenerate them with the mapper.

## Quick start

After cloning this repo:

```bash
bun run ai:sync
```

This reads `ai/` and writes per-tool artifacts (all gitignored).

## Layout

```
ai/
├── AGENTS.md           # main guide doc (single file, no folder)
├── rules/<n>.md        # rule topics (plain markdown — no frontmatter scope/globs)
├── knowledge/<n>.md    # niche code-specific facts, design-system notes,
│                       # product-decision rationale NOT covered by docs/
├── skills/<n>/SKILL.md # cross-tool SKILL.md packages
├── workflows/<n>.md    # slash-command prompt templates
├── agents/<n>.md       # named agent personas (frontmatter: name/description/tools/model + body)
├── tools/              # shared helper scripts (bash, python, ts — anything)
├── mapper/             # the mapper (Bun TypeScript)
└── mapper.config.toml  # mapper configuration
```

## Mapping table

| ai/ source | Claude | Codex | Gemini | Cursor | Antigravity |
|---|---|---|---|---|---|
| `AGENTS.md` | `CLAUDE.md` | `AGENTS.md` | `GEMINI.md` | `AGENTS.md` | `.agent/AGENTS.md` |
| `rules/<n>.md` | `.claude/rules/<n>.md` (auto-loaded) | `.codex/rules/<n>.md` (read manually) | `.gemini/rules/<n>.md` (read manually) | `.cursor/rules/<n>.mdc` (auto-loaded) | `.agent/rules/<n>.md` (auto-loaded) |
| `knowledge/<n>.md` | (in `CLAUDE.md`) | (in `AGENTS.md`) | (in `GEMINI.md`) | (in `AGENTS.md`) | (in `.agent/AGENTS.md`) |
| `skills/<n>/` | `.claude/skills/<n>/` | `.agents/skills/<n>/` | `.gemini/skills/<n>/` | `.cursor/skills/<n>/` | `.agent/skills/<n>/` |
| `workflows/<n>.md` | `.claude/commands/<n>.md` | SKIP | `.gemini/commands/<n>.toml` | `.cursor/commands/<n>.md` | `.agent/workflows/<n>.md` |
| `agents/<n>.md` | `.claude/agents/<n>.md` | `.codex/agents/<n>.toml` | `.gemini/agents/<n>.md` | `.cursor/agents/<n>.md` | SKIP |
| `tools/*` | `.claude/tools/` | `.codex/tools/` | `.gemini/tools/` | `.cursor/tools/` | `.agent/tools/` |

## AI Contribution Guide

The `ai/` folder is the **single source of truth** for all AI agent memory, instructions, and rules shared by the team. Every developer and agent working on this repository contributes to this folder, and changes are automatically synchronized and distributed to all LLM providers.

### 1. The Core Conventions

- **Everything in `ai/` is Committed**: All rule files, knowledge bases, agent definitions, workflows, and tools under `ai/` are checked into git.
- **Generated Tool Dirs are Gitignored**: All generated folders and files (like root `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursor/`, `.gemini/`, `.agent/`, `.claude/`) are strictly gitignored. **Never edit files inside generated folders directly** — they are completely overwritten by the sync mapper.
- **Auto-Distribution to LLM Providers**: Running the sync mapper reads the single source of truth in `ai/` and translates, formats, and distributes the artifacts to the specific directories expected by Cursor, Claude Code, Gemini CLI, Codex, and Antigravity. This ensures that *every* assistant has the exact same project memory and rules.

---

### 2. The Boundary Test: Personal vs. Project-Shared

Before adding a new fact, rule, or guideline to `ai/`, run the **Boundary Test** to verify if it belongs in the shared repository context or your personal developer config:

| Question | If Yes | If No |
|---|---|---|
| Can I cite a specific file or line in THIS repo that backs this up? | **Project-Shared** (Keep) | Personal (Skip) |
| Would a brand-new teammate trip over this if they didn't know it? | **Project-Shared** (Keep) | Personal (Skip) |
| Is this a must-do or must-not-do directive specific to this repo? | **Rule** (`ai/rules/`) | Personal Config (Skip) |
| Is this a niche fact, design-system note, or gotcha NOT in `docs/`? | **Knowledge** (`ai/knowledge/`) | Redirect to `docs/` or Skip |
| Is this an opinion about IDE theme, terminal styling, or chrome? | Personal Config (Skip) | Continue |
| Is this a generic TS/JS/React pattern unrelated to this codebase? | Personal Config (Skip) | Continue |

---

### 3. Categorizing Your Contributions

When adding new information, place it in the correct category under `ai/` using the following decision tree:

1. **Directives (Must-Do / Must-Not-Do)**: Append to or create a plain markdown file under `ai/rules/<topic>.md`.
2. **Niche Code Gotchas & Design Rationales**: Create or append to a file under `ai/knowledge/<topic>.md`. (Broad product documentation belongs in `docs/`; use `ai/knowledge/` only for agent-centric niche context).
3. **Reusable Procedures (Skills)**: Create a skill package under `ai/skills/<name>/SKILL.md` (with YAML frontmatter `name` and `description`).
4. **Slash-Command Prompt Templates (Workflows)**: Create a workflow file under `ai/workflows/<name>.md`.
5. **Shared Helper Scripts (Tools)**: Drop executable helper scripts (Bash, TypeScript, Python) under `ai/tools/`.

---

### 4. How to Sync and Validate Your Changes

Every time you modify files inside the `ai/` folder, you **must** regenerate the per-tool directories to keep all LLM providers in sync:

1. **Sync Artifacts**: Run the sync mapper script:
   ```bash
   bun run ai:sync
   ```
   This executes `ai/mapper/index.ts`, translating and distributing the updated memory.
   
2. **Validate Sync State**: Run the check utility to confirm that your generated gitignored folders perfectly match the current `ai/` source:
   ```bash
   bun run ai:check
   ```
   This is a local convenience check that exits with code `1` if the generated artifacts are out of sync.

Edit only files under `ai/`, run `bun run ai:sync` to regenerate, and commit the modified `ai/` files to Git.

