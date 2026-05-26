---
description: Enrich the repo's ai/ source from a developer's personal AI context (user-global configs, recent conversations, local notes). Step-by-step non-stop workflow that never blocks on clashes — silently isolates them and prints a clash report at the end for the developer's discretion.
---

# Contribution Workflow — enriching `ai/` from your personal context

## Why this exists

The repo's `ai/` folder is the **single source of truth** for AI artifacts shared with the team. Each developer accumulates two parallel knowledge surfaces over time:

1. **User-global**: `~/.claude/`, `~/.cursor/`, `~/.codex/`, `~/.gemini/`, plus whatever conversation memory their tools keep about projects they work on.
2. **Project-shared**: this repo's `ai/` folder, distributed via the mapper to every developer.

Project-shared content (1) is invisible to teammates. When a developer hits a non-obvious bug, discovers a convention by reading code, or codifies a workflow that the team should know — that finding lives only in their personal context until someone moves it. This workflow is the move.

**Core principle of this workflow:** it never stops on conflicts. If your candidate contradicts an existing rule, it gets isolated and printed at the end for your discretion — the rest of the flow continues. You decide later whether (a) you should update your own habit, (b) the existing rule is wrong and needs a separate PR, or (c) it's a genuine divergence that requires team discussion. **The workflow's job is to surface; the human's job is to adjudicate.**

---

## When to use this workflow

Run it when any of these is true:

- You finished a non-trivial task on this repo and noticed yourself learning facts that "everyone else should know."
- You read code and discovered a convention that's currently uncodified.
- You debugged a gotcha that took >30 minutes and the cause is non-obvious from the code.
- A teammate asked you "where is X documented?" and you realized it isn't.
- You're onboarding to the repo, you've been making notes for yourself in `~/.<tool>/`, and you want to give them to the team.
- It's been ≥1 month since you last contributed to `ai/` and you've done substantial repo work in that window.

Do **not** run it for personal preferences (theme, IDE shortcuts, MCP servers, your TS-style opinions). Those belong in your user-global config forever.

---

## Inputs the workflow needs

Before starting, the developer should be able to point the AI agent at:

| Input | Typical location | What the agent does with it |
|---|---|---|
| User-global tool config | `~/.claude/CLAUDE.md`, `~/.cursor/`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md` | Scans for repo-specific notes that ended up in personal files |
| Tool conversation memory | `~/.claude/projects/...` or equivalent | Scans recent conversations FOR THIS REPO for codified facts |
| Local scratch notes | `.tmp/`, `.personal/`, `~/Desktop/` notes the dev points at | Scans for half-written rules / runbooks |
| The repo `ai/` source | `ai/` folder in current repo | Source of truth to compare candidates against |
| The repo `docs/` source | `docs/` at repo root (if exists) | Source of truth for non-niche docs — candidates duplicating docs should redirect there |

The agent should not invent inputs — if the developer hasn't pointed at a source, the agent skips that source and notes the gap in its final summary.

---

## The boundary test — personal vs project-shared

For every candidate fact the agent finds, ask:

| Question | If "yes" | If "no" |
|---|---|---|
| Can I cite a file:line in THIS repo that backs this up? | project-shared | personal (skip) |
| Would a brand-new teammate trip over this if they didn't know it? | project-shared | personal (skip) |
| Is this a niche fact that's NOT in `docs/`? | candidate for `ai/knowledge/` | redirect to `docs/` |
| Is this a must-do or must-not-do directive specific to this repo? | candidate for `ai/rules/` | candidate for personal config |
| Is this a multi-step procedure invoked as a slash command? | candidate for `ai/workflows/` | candidate for `ai/knowledge/` |
| Is this an opinion about IDE chrome, theme, keybindings? | personal (skip) | continue |
| Is this a generic TypeScript / JavaScript / React preference unrelated to this codebase? | personal (skip) | continue |

A candidate passes the boundary if **at least one yes lands on a `project-shared` row**. If only personal rows answer yes, drop the candidate silently — it stays in the developer's user-global config where it belongs.

---

## The workflow (10 phases, non-stop)

The agent runs these phases in order. **No phase blocks the next**: clashes are captured but never abort the flow. Each phase has a clear input → action → output contract.

---

### Phase 1 — Prepare

**Action:**

1. Verify the working tree is clean: `git status --short`. If there are uncommitted changes, ask the developer to commit, stash, or explicitly opt in to running over a dirty tree (some intermediate state is unavoidable). Note in the summary if the tree was dirty.
2. Pull the latest `ai/` from main: `git pull --rebase`.
3. Run `bun run ai:sync` (or the repo's equivalent — see the repo's `package.json`) to ensure the developer's local per-tool dirs (`.claude/`, `.cursor/`, etc.) match the latest source.
4. Read `ai/AGENTS.md` end to end. It is the navigation index — the agent must know the existing groups before proposing new files.
5. List the current `ai/rules/` subdir groups and `ai/knowledge/` subdir groups. Capture as the **destination map**.
6. List every `*.md` file in `ai/rules/` and `ai/knowledge/` (recursive). Capture as the **existing-content inventory** — used in Phase 4 for clash detection.

**Output of phase 1:** clean working tree, fresh `ai/`, navigation index in working memory, destination map + content inventory ready.

---

### Phase 2 — Inventory candidate sources

**Action:**

For each input the developer pointed at, scan it for content that mentions this repo by name, mentions repo-specific file paths, or describes patterns / conventions / gotchas that obviously apply only here.

Concrete sub-actions:

1. **User-global tool config**: grep `~/.claude/CLAUDE.md` (and equivalents) for repo names (`proxai_web`, `proxai_nest`, `proxai_ops`, `proxai_gateway`, `proxai_prisma`), for file paths starting with `src/` / `app/` / `proxai-ui/`, and for repo-specific identifiers (`SERVICE` keys, `OrgRole`, `BullMQPriority`, etc.).
2. **Tool conversation memory**: read recent conversation indexes for entries about this repo. If the tool exposes a memory directory (Claude Code does at `~/.claude/projects/...`), list it. If not, the agent skips this source and notes it in the summary.
3. **Local scratch notes**: any file the developer explicitly points at — read it and extract candidate statements.

For each candidate, capture a structured record:

```
{
  source: '~/.claude/CLAUDE.md',         // where it came from
  line_range: '142-156',                  // for traceability
  raw_text: '...',                        // the original wording
  candidate_summary: '...',               // one-sentence distillation
  proposed_category: 'rule' | 'knowledge' | 'workflow' | 'skill' | 'agent',
  proposed_destination: 'ai/rules/auth/<slug>.md',
  evidence: ['src/auth/auth.guard.ts:32-39', ...]  // file:line backing
}
```

**Do not write any files yet.** Phase 2 is collection only.

**Output of phase 2:** a candidate list with structured records. Empty is fine — print "no project-shared content found, you're up to date" and exit gracefully if so.

---

### Phase 3 — Classify each candidate

**Action:**

For each candidate from Phase 2, run the boundary test (table above). Bucket into:

- **KEEP** — project-shared, evidence-backed, not personal preference.
- **SKIP-PERSONAL** — personal preference or generic, drop silently.
- **SKIP-IN-DOCS** — a niche fact that actually belongs in `docs/` because it's not niche enough for `ai/knowledge/`. Note as a `docs/` improvement candidate in the summary, but do not write to `ai/`.

**Output of phase 3:** the KEEP list. Continue with KEEP only.

---

### Phase 4 — Cross-check + clash detection

**Action:**

For each candidate in KEEP, do two passes against the existing-content inventory from Phase 1:

**Pass 4a — duplicate detection.** Does an existing `ai/rules/` or `ai/knowledge/` file already cover this? Use:

- File-name similarity (e.g., candidate is `auth/api-key-guard` and a file at `ai/rules/auth/api-key-guard.md` exists).
- Content overlap: search the existing inventory for the candidate's key terms (`SERVICE`, `OrgRole`, `removeOnComplete`, `font-[family-name`, etc.).

If a duplicate exists:

- If the candidate ADDS information not in the existing file → bucket as **MODIFY** (proposed edit to the existing file).
- If the candidate fully overlaps → bucket as **SKIP-DUPLICATE** (drop silently; the team already knows this).

**Pass 4b — clash detection.** Does the candidate CONTRADICT an existing rule or knowledge fact? Example contradictions:

| Candidate says | Existing says | Verdict |
|---|---|---|
| "Use class-variance-authority for variants" | `ai/knowledge/proxai-ui/composition-patterns.md`: "we use plain `Record<…, string>` + `cn()`, NOT CVA" | CLASH |
| "Always use `mock.module(...)` in tests" | `ai/rules/process/no-mockmodule-only-spyon-deps.md`: "never `mock.module`; always `spyOn(__deps)`" | CLASH |
| "ApiKeyType.OPS is allowed for ops scripts" | `ai/rules/auth/api-key-guard.md`: "no OPS member — three values only" | CLASH |
| "Use `npm install`" | `ai/rules/_always.md`: "bun only — never npm/pnpm/yarn" | CLASH |

For each clash, capture:

```
{
  candidate: <full record>,
  clashing_file: 'ai/rules/.../<name>.md',
  clashing_quote: '...',                  // the exact passage that contradicts
  contradiction_summary: 'one-line WHY they conflict',
  suggested_resolution_options: [
    'A) Update your habit to match the existing rule',
    'B) Open a separate PR to revisit the existing rule (the rule may be wrong)',
    'C) Discuss with team — genuine ambiguity'
  ]
}
```

**Bucket the clash as SKIP-CLASH. Do not write the candidate to `ai/`. Do not modify the existing file. Continue to the next candidate.** The clash record goes into the final clash report.

**Output of phase 4:** Refined buckets — **ADD** (new file), **MODIFY** (edit existing), **SKIP-DUPLICATE** (drop), **SKIP-CLASH** (collect for end-of-run report).

---

### Phase 5 — Categorize destinations

**Action:**

For each ADD candidate, pick the correct subdir using the navigation index from `ai/AGENTS.md`.

Rules of placement:

1. **Reuse an existing subdir whenever possible.** If a candidate fits in `ai/rules/auth/`, put it there. Never create a new subdir to hold a single new file.
2. **Only create a new subdir if you have 3+ files** that all belong in it AND none of the existing groups fits. Creating a `ai/rules/security-audit/` with one file is anti-pattern — either find an existing group or wait for siblings.
3. **Single-file subsystems go at the knowledge root.** `ai/knowledge/<topic>.md` is the right home for a 1-file domain that doesn't yet need a subdir.
4. **Workflows go flat under `ai/workflows/`.** Skills go in their own folder under `ai/skills/<name>/SKILL.md`. Agents go flat under `ai/agents/<name>.md`.

For each MODIFY candidate, locate the exact insertion point inside the existing file (an existing section, a new H2, the end of a table, etc.).

**Output of phase 5:** Every ADD has a final destination path. Every MODIFY has a final destination path + insertion anchor.

---

### Phase 6 — Draft proposed files

**Action:**

Write the proposed file content **to memory / a scratch buffer — not to disk yet.** Each proposed file must satisfy:

- Plain markdown body, no YAML frontmatter (except workflows + skills + agents which require frontmatter).
- Rule files: state the rule in the FIRST sentence / first paragraph. Imperative voice. No buried lede.
- Knowledge files: lead with the WHY before the HOW. Use tables for cross-item comparisons.
- Every claim has a citation: end the file with `[source: file:line; file:line; ...]`. Cite the actual repo source code that backs the claim, not just memory.
- No `any` in any code example. Use `unknown` + type guard, `as unknown as TargetType`, `Prisma.JsonValue`, etc.
- Cross-link with relative paths: `see [other-file.md](./other-file.md)` or `see [../<group>/<file>.md]`.
- Code blocks 5–15 lines, real signatures pulled from source.
- File length: 80–250 lines. Shorter is fine for narrow rules; longer means split.
- File name: `kebab-case.md`. No spaces, no underscores (except `_always.md` and `_overview.md` which are the documented exceptions).

For MODIFY candidates, draft the exact diff (the added paragraph / table row / cross-link), not a wholesale rewrite. Preserve the existing file's structure and prose.

**Output of phase 6:** Drafts ready to present.

---

### Phase 7 — Present diff to developer, get approval

**Action:**

Present everything in a structured summary:

```
=== Contribution proposal ===

ADD (new files):
  • ai/rules/auth/foo.md (NEW, 142 lines)
    Summary: ...
    Source: ~/.claude/CLAUDE.md:42-58
    Evidence: src/auth/foo.ts:12-30

  • ai/knowledge/queues/bar.md (NEW, 88 lines)
    Summary: ...
    [...]

MODIFY (additions to existing files):
  • ai/knowledge/proxai-ui/registry.md (+1 table row)
    Diff:
      | NewComponent | Base UI | New primitive for ... |

SKIP-DUPLICATE:
  • Candidate from ~/.claude/CLAUDE.md:104 already covered by ai/rules/data/react-query.md

SKIP-PERSONAL:
  • Candidate from ~/.cursor/...: 'I prefer 2-space indent' — personal preference, not codified

SKIP-CLASH (printed in detail at the end — see clash report):
  • 2 candidates contradict existing rules. Workflow continues; you decide.

=== Approve? Per-file or all-at-once. ===
```

Pause for the developer to approve per-file or all-at-once. The agent does not write to disk until approval. **The clash report is NOT shown here yet — it's at the end, after the rest of the work is committed to memory.**

**Output of phase 7:** Approved ADD list, approved MODIFY list.

---

### Phase 8 — Apply approved changes

**Action:**

1. For each approved ADD, write the file to its final path using the Write tool.
2. For each approved MODIFY, apply the diff using the Edit tool at the insertion anchor. Do not touch any other part of the existing file.
3. If a new subdir was created (rare, see Phase 5 rules), update `ai/AGENTS.md`'s navigation index to mention the new group. Use the existing index format.
4. Do not stage, do not commit. The developer reviews unstaged.

**Output of phase 8:** Files written to disk under `ai/`. Working tree shows unstaged additions/modifications.

---

### Phase 9 — Mapper sync + validate

**Action:**

1. Run `bun run ai:sync` (the repo's mapper invocation). Confirm output is `emitted N files; removed M stale` with no errors.
2. Run `bun run ai/mapper/index.ts --check`. Confirm `no drift`.
3. Run `bun run validate` if the repo has one — or the closest equivalent (`bun run ts:check` + `bun run lint`). If any step fails, the workflow does NOT abort: it captures the failure into the final summary as a `POST-APPLY ISSUE` and continues.
4. Confirm the unstaged surface only includes `ai/` files (plus any auto-formatted prettier touch-ups). If files outside `ai/` were modified by accident, list them in the final summary as `UNEXPECTED CHANGES` for the developer to investigate.

**Output of phase 9:** Mapper synced, generated per-tool artifacts up to date in `.claude/`, `.cursor/`, etc. (all gitignored). Validate results captured.

---

### Phase 10 — Print the clash report + final summary

**Action:**

Print to the developer (terminal-friendly, scannable):

```
================================================================
Contribution complete — summary
================================================================

ADDED (N files):
  ai/rules/auth/foo.md (142 lines)
  ai/knowledge/queues/bar.md (88 lines)
  [...]

MODIFIED (M files):
  ai/knowledge/proxai-ui/registry.md (+1 row)

SKIPPED (duplicates): K
SKIPPED (personal): K
SKIPPED (in-docs): K

Mapper: emitted N; removed M stale; no drift
Validate: PASS / FAIL with details

----------------------------------------------------------------
⚠️  CLASH REPORT — your discretion required
----------------------------------------------------------------

Clash #1
  Your note (from ~/.claude/CLAUDE.md:142):
    "Always use class-variance-authority for component variants."

  Conflicts with: ai/knowledge/proxai-ui/composition-patterns.md
  Quoted: "The library does NOT use class-variance-authority; variants
           are plain Record<…, string> records combined with cn()."

  Why they conflict: Two different patterns for the same problem. The
  existing rule cites src/.../button.tsx:36-78 as evidence.

  Your options:
    A) Update your habit to use plain Record + cn() (recommended unless
       you have evidence the library moved to CVA recently)
    B) Open a separate PR to revisit composition-patterns.md if you have
       evidence it's wrong
    C) Discuss with team — possibly genuine divergence between layers

Clash #2
  [...]

----------------------------------------------------------------
NEXT STEPS
----------------------------------------------------------------

1. Review the unstaged diff:
     git diff ai/
2. If happy, commit:
     git add ai/
     git commit -m "docs(ai): <short description of what you added>"
3. Open PR. The team reviews per-file (the modular layout makes review
   fast).
4. For each clash above, decide which option to take. If you pick option
   B, open a separate PR with rationale + evidence.
================================================================
```

If there are no clashes, omit the clash report section and say "No clashes — clean contribution."

If validate failed in Phase 9, surface the failure prominently in the summary with a suggested fix step.

**Output of phase 10:** Developer has everything they need to commit, push, and PR. The clash report is the only thing requiring follow-up judgment.

---

## Clash handling — deep dive

The clash report is the workflow's most important output. Three principles:

1. **Never silently overwrite.** Even if the candidate seems "obviously better," the existing rule was put there for a reason. The clash report surfaces both sides; the developer (or the team) decides.
2. **Never silently drop.** A clash is data — it tells you either your habits are stale, or the rule is. Logging it forces the conversation.
3. **Never block the workflow.** A clash on rule N must not stop rules N+1, N+2, ... from being added. Run-to-completion.

**Common clash patterns and the right resolution:**

| Pattern | Likely cause | Recommended resolution |
|---|---|---|
| Candidate cites old behavior that has since been refactored | Developer's user-global config is stale | A) Update habit |
| Candidate cites new behavior the rule doesn't know about yet | Rule is stale; codebase moved on | B) Update the rule via separate PR |
| Both habit and rule are defensible | Genuine ambiguity | C) Team discussion |
| Candidate is shorthand for something more specific | Candidate is under-specified | Rewrite the candidate with more precision and re-run the workflow |

---

## Required formatting standards for every contributed file

(restating from Phase 6 in checklist form so the agent can verify before writing)

- [ ] Rule files: rule stated in first sentence/paragraph.
- [ ] Knowledge files: WHY before HOW.
- [ ] Every claim cited with `[source: file:line; ...]` at end of file.
- [ ] No `any` in any code example.
- [ ] No suppression comments in examples.
- [ ] Cross-links use relative paths (`./other-file.md` or `../<group>/<file>.md`).
- [ ] Code blocks pulled from real source, 5–15 lines.
- [ ] Tables for 3+ item comparisons.
- [ ] File name `kebab-case.md` (exceptions: `_always.md`, `_overview.md`).
- [ ] File length 80–250 lines. If longer, split into multiple files in the same group.
- [ ] Frontmatter ONLY on workflows / skills / agents (NOT on rules / knowledge).
- [ ] Workflows + skills + agents follow their respective frontmatter contracts (`description`, `name`, `tools`, `model`).

---

## Examples — good vs bad contributions

**GOOD example (a rule):**

```markdown
# Throttler chain — fail-open on Redis errors

`CustomThrottlerGuard` MUST fail open when its Redis storage rejects.
A Redis blip cannot become an app-wide 5xx wave; rate limiting is a
floor, not a ceiling.

## The contract

[code block from src/common/throttle/custom-throttler.guard.ts:138-165]

## Why

[concrete explanation referencing the actual incident or design decision]

[source: src/common/throttle/custom-throttler.guard.ts:138-165; src/common/throttle/throttle.redis.ts:13-25]
```

Why it's good: rule in the first paragraph, real code quoted, citation at end, no `any`, fits an existing subdir (`ai/rules/auth/`).

**BAD example (a rule):**

```markdown
# Throttler stuff

I think we should make sure the throttler doesn't break the app if Redis
is having problems. Maybe we should add some error handling? In my
experience, it's usually a good idea to wrap shell calls in try/catch.
```

Why it's bad: no rule stated, no citation, no evidence, uses "I think," generic ("in my experience"), mixes two unrelated concerns (throttler + shell), no destination apparent.

---

## After the workflow — PR and review

The developer commits + opens a PR. The reviewer's checklist:

1. Is every claim source-cited?
2. Is the destination subdir correct? (Match against `ai/AGENTS.md`'s navigation index.)
3. Does any addition duplicate existing content?
4. Does any addition contradict existing content? (If the workflow ran correctly, contradictions land in the clash report, not the PR — but spot-check.)
5. Is the file length reasonable? (Split if >250 lines.)
6. Did the mapper run cleanly post-merge?

If anything fails review, fix it in the PR — don't merge a stale or duplicative addition.

---

## Anti-patterns — what NOT to add

- **Personal preferences:** indent width, brace style, naming preferences that aren't already codified.
- **Generic tech opinions:** "React Query is better than SWR" — not a project-specific fact.
- **Stale findings:** "this used to be true 6 months ago" — verify against current code before contributing.
- **Speculation:** "I think the team should consider X" — propose via a doc, not as a rule.
- **Process documents:** "how to run tests" already lives in `package.json` + `_always.md`; don't duplicate.
- **Vague rules:** "Be careful with async code" — too vague to enforce. State the specific situation.
- **Documentation that belongs in `docs/`:** broad subsystem docs, design specs, architecture references go in `docs/`, not `ai/knowledge/`.
- **Anything you can't cite to a file:line in this repo.**

---

## Closing note

This workflow exists because shared knowledge compounds. One developer's "I had to figure that out the hard way" becomes the team's "we always do it this way." The mapper distributes it everywhere automatically. Your job is to find the candidates and run this workflow. The clash report respects your judgment; you respect the existing team norms unless you have evidence to override them.
