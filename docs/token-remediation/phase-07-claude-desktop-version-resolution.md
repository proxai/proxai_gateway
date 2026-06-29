# Phase 7 — Claude Desktop version resolution

- **Status:** ⚠️ **RE-SCOPED — original premise INVALID** (verified against read-only prod 2026-06-29). Do NOT implement as written.
- **Severity:** ~~🟠 medium~~ → 🟢 low (no lost token data; the open item is cleanup, not a correctness fix)
- **Effort:** S (docs) + a separate decision on retiring/deduping the redundant source
- **Repos:** proxai_nest + proxai_gateway
- **Depends on:** — · **Blocks:** — (Phase 11 no longer needs a Desktop backfill — see below)
- **Source:** VERIFICATION_FINDINGS.md §11.2 · IMPLEMENTATION_PLAN.md Rank 7 — **both wrong on this point**

## TL;DR (the correction)
The original premise — "Claude Desktop produces 0 ACRs → usage is uncounted → fix `claude-desktop/v2` version resolution to recover it" — is **false and the proposed fix is harmful**:
- **Desktop conversation tokens are already counted**, under the **`CLAUDE_CODE`** agent as `source_platform = claude-code-desktop` (**811 ACRs** with full token data in prod). Desktop runs the embedded CC CLI → writes `.claude/projects/*.jsonl` → the **claude-code source** captures + tags them.
- The `CLAUDE_DESKTOP` agent / `claude-desktop/v2` path is a **separate, ~97%-redundant** `audit.jsonl` stream. "Fixing" its version resolution would **double-count** Desktop tokens.

## Empirical evidence (read-only prod, 2026-06-29)
**ACR rows by agent** — there is no `CLAUDE_DESKTOP` agent at all:

| agent | ACR rows | | agent | ACR rows |
|---|---|---|---|---|
| CLAUDE_CODE | 17,683 | | gemini | 1,522 |
| CODEX | 2,083 | | **CLAUDE_DESKTOP** | **0 (absent)** |
| CURSOR | 1,671 | | | |

**Desktop usage is recorded under CLAUDE_CODE:** `CLAUDE_CODE / claude-code-desktop = 811 ACRs` (plus `claude-code-cli` 2,698, `null` 14,174).

**The dedicated `claude-desktop` source captures a redundant parallel stream:** `source_app=claude-desktop / claude-cowork-desktop = 468 captures → 0 ACRs, 0 parse states` (not even `UNSUPPORTED_VERSION`). Of those 468, **456 carry a real CLI version** (`agent_schema_version = claude-desktop/2.1.x`) — meaning the `audit.jsonl` record matched a `.claude/projects` transcript ([gateway collect.ts:198-199](../../src/sources/claude-desktop/collect.ts)), i.e. the **same conversation already captured as `claude-code-desktop`**. Only 8 `claude-desktop/v2` + 4 `unknown` did not match.

## The real architecture
| Stream | On-disk | Gateway source | Lands as | Records |
|---|---|---|---|---|
| Conversation transcripts (tokens) | `~/.claude/projects/*/*.jsonl` | **claude-code** | `CLAUDE_CODE` / `claude-code-desktop` | ✅ 811 ACRs |
| `audit.jsonl` (cowork / local-agent-mode) | `local-agent-mode-sessions/*/audit.jsonl` | **claude-desktop** (`claude-desktop/v2`) | `CLAUDE_DESKTOP` | ❌ 0 (dropped at version gate) |

The claude-desktop collector reads `audit.jsonl`, keeps only `isDialogueRecord`s, and **cross-references each record to the `.claude/projects` transcripts by `uuid` / `message.id`** to enrich `cwd`/version — direct evidence the two streams are the **same conversations**.

## Why the original fix is HARMFUL (not just unnecessary)
ACR id = `blake2b_128(agent | chat_id | turn_id)`. Re-parsing the same conversations under `CLAUDE_DESKTOP` mints **new ids** (agent differs) → both the `CLAUDE_CODE/claude-code-desktop` row and a new `CLAUDE_DESKTOP` row persist → **Desktop tokens double-counted** in every aggregate. The current drop *protects* the data; the `parsers.versions.ts:187` plain-`semverScheme` "bug" (can't resolve the `claude-desktop/` prefix) is effectively load-bearing.

## Re-scoped recommendation
1. **Do NOT implement the version-resolution fix.** (Done: this doc + ROADMAP corrected; the `parsers.versions.ts:183-186` comment + `desktop-routing.md` should be corrected to say the drop is intentional/protective — tracked as a small nest follow-up.)
2. **Phase 11:** no Desktop backfill — that data is already under `CLAUDE_CODE`.
3. **Optional cleanup (separate decision):** the `claude-desktop` gateway poller uploads ~468 redundant captures to S3. Consider **retiring it** to stop wasting storage/bandwidth. Confirm first with a capture-body spot-check that the cowork sessions are fully contained in the `claude-code-desktop` set.
4. **Only if a genuinely-unique cowork subset exists** (the ~12 `claude-desktop/v2`/`unknown` captures that didn't match a transcript): a *deduped* ingestion is a real (larger) feature — never naive version-gate resolution.

## Verification method (reusable)
Read-only prod via `POSTGRES_URL_READ_ONLY_PROD` (nest `.env`) + `wrapPrismaForRead` proxy, typed `groupBy` only (`ai/rules/persistence/no-raw-sql-in-agent-scripts.md`): `agentCallRecord.groupBy(['agent'])`, `groupBy(['agent','sourcePlatform'])`, `agentParseState.groupBy(['agent','status'])`, `agentRawCapture.groupBy(['sourceApp','sourcePlatform'])` + `groupBy(['agentSchemaVersion'])` where `sourceApp='claude-desktop'`.

---

## ORIGINAL premise (PRESERVED FOR THE RECORD — INVALID)
> Claude Desktop produces ZERO ACRs — the gateway stamps `claude-desktop/v2` but nest registers `CLAUDE_DESKTOP` under the plain `semverScheme` with no prefix strip, so `semver.valid(...)` is null → `UNSUPPORTED_VERSION`. The proposed fix was to strip `claude-desktop/` (mirror `geminiScheme`) so Desktop produces ACRs.

Why it's wrong: (a) Desktop conversations are NOT uncounted — they're under `CLAUDE_CODE/claude-code-desktop`; (b) prod shows **0** `CLAUDE_DESKTOP` parse states, not `UNSUPPORTED_VERSION` ones, so the captures don't even reach that gate the way the doc assumed; (c) making the prefix resolve would double-count. The detailed change-spec/tests/acceptance-criteria from the original revision are withdrawn.
