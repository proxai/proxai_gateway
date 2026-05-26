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

## When you learn something — extend `ai/`

If working in this repo and you learn a new rule, niche fact, useful skill, or workflow, **edit `ai/` directly** (don't add per-tool files). The mapper propagates to every LLM on next `bun run ai/mapper/index.ts`. See the "Extending the AI memory" section in any generated main doc (CLAUDE.md / AGENTS.md / GEMINI.md / .agent/AGENTS.md) for the decision tree.

If the repo has a `docs/` folder, prefer adding broad documentation there. Use `ai/knowledge/` only for niche items beyond docs.

## Editing

Edit files under `ai/`. Run `bun run ai:sync` to regenerate per-tool artifacts. Commit only changes under `ai/`.

## Keeping `ai/` in sync with generated artifacts

After any change under `ai/`, run `bun run ai:sync` locally. Generated files (`AGENTS.md`, `.claude/`, `.cursor/`, etc.) are all gitignored — only `ai/` is committed.

`bun run ai:check` is a local convenience: it exits 1 if your generated artifacts don't match the current `ai/` source.
