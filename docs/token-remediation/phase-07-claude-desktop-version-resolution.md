# Phase 7 — Claude Desktop version resolution

- **Status:** ⬜ NOT STARTED
- **Severity:** 🟠 medium · **Effort:** S
- **Repos:** proxai_nest + proxai_gateway
- **Depends on:** Phases 1, 4, 5 (Desktop INHERITS those Claude-Code fixes by routing) · **Blocks:** Phase 11
- **Source:** VERIFICATION_FINDINGS.md §11.2 · IMPLEMENTATION_PLAN.md Rank 7

## Concern this phase eliminates
Claude Desktop produces **ZERO** ACRs — the "0 prod rows" is a structural BUG, not low usage. The gateway stamps
a prefixed `agentSchemaVersion` (`claude-desktop/v2`) but nest registers `CLAUDE_DESKTOP` under the plain
`semverScheme` with no prefix strip, so `semver.valid(...)` is null → every Desktop chat is marked
`UNSUPPORTED_VERSION` before any extractor runs. When merged, prefixed Desktop versions resolve and Desktop
produces ACRs.

## ⚠️ Sequencing gate
Desktop reuses the Claude Code parser, so the moment it resolves it INHERITS F1 (dialogue-filter under-count) and
the F4/orphan-drop idle behavior. **Ship this ONLY after Phases 1, 4, and 5 are merged**, otherwise you light up
a known-undercounting path. The orchestrator will not green-light Phase 7 until 1/4/5 are ✅.

## Background (read first)
- Gateway stamps prefixed version: `proxai_gateway/src/sources/claude-desktop/collect.ts:171-180`,
  `claude-desktop.constants.ts:15` (default `claude-desktop/v2`).
- Nest registration with NO prefix strip: `proxai_nest/src/agent-gateway/parsers/parsers.versions.ts:186`
  (plain `semverScheme`) vs the working pattern `geminiScheme` `:163-178` (which strips `antigravity/`).
- Short-circuit: `proxai_nest/src/agent-gateway/parse/services/parse-process-chat.service.ts:125-145` marks
  `UNSUPPORTED_VERSION` when `resolveParserSet` returns null.
- Stale docs to fix: the `parsers.versions.ts:182-186` comment ("same scheme as CC") and
  `proxai_nest/.claude/knowledge/agent-gateway/desktop-routing.md` ("0 rows = low-volume/historical").

## Change spec
### proxai_nest
- Register `CLAUDE_DESKTOP` under a prefix-stripping scheme that strips `claude-desktop/` (mirror `geminiScheme`'s
  `antigravity/` strip), OR otherwise reconcile the version contract so the prefixed value resolves.
  `parsers.versions.ts:163-178` (pattern), `:182-190`.
- Fix the `:182-186` comment.
- Update `desktop-routing.md` to state the real cause was the version short-circuit.

### proxai_gateway
- Confirm/align the version contract (`claude-desktop/collect.ts:171-180`, `claude-desktop.constants.ts:15`) with
  whatever strip nest implements (no change if nest strips the existing prefix).

## Tests (verifier checks these)
- A reference test resolving a real `claude-desktop/v2` `agentSchemaVersion` end-to-end → resolves to the Claude
  Code parser set (NOT UNSUPPORTED_VERSION).
- A Desktop capture fixture produces ACRs with the (now-fixed, post-Phase-1) usage handling.

## Acceptance criteria (100% = all true)
- [ ] Phases 1, 4, 5 are ✅ (sequencing gate).
- [ ] A prefixed `claude-desktop/v2` version resolves; Desktop chats no longer hit UNSUPPORTED_VERSION.
- [ ] Reference test exists.
- [ ] `parsers.versions.ts` comment + `desktop-routing.md` corrected.

## Merge checklist
- [ ] proxai_nest PR merged
- [ ] proxai_gateway PR merged (if any contract change)

## Orchestrator quick-check (run on "Phase 7 done")
- Confirm Phases 1/4/5 are ✅ first.
- `grep -n "claude-desktop\|stripPrefix\|CLAUDE_DESKTOP" proxai_nest/src/agent-gateway/parsers/parsers.versions.ts`
  → confirm a prefix-stripping scheme is registered for Desktop.
- Confirm the end-to-end version-resolution test exists.

## Data-refresh implication
✅ Backfillable. Desktop captures are in S3; Phase 11 re-parse populates them once this resolves (with the
Phase-1 fix already applied so they don't under-count).
