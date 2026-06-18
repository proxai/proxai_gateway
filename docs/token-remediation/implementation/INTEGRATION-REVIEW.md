# Token Remediation — Implementation-Plan Integration Review

> **Owner:** orchestrator chat. **Date:** 2026-06-18.
> Capstone review across all 11 phase implementation plans in this folder, after the
> create → verify → fix rounds. Confirms the plans are individually deployment-ready and
> mutually consistent (shared files coordinated, dependencies honored, no conflicting
> instructions). This is a planning artifact — no product code was implemented.

---

## 1. Status board

| Phase | Plan | Repos | Round-2 verdict | Fixes applied | State |
|---|---|---|---|---|---|
| 01 | usage preservation | gw + nest | — (already implemented) | — | ✅ implemented + verified + on branch |
| 02 | Codex over-count (cumulative diff + cross-tick anchor) | nest | material-gaps | ✅ (annotations stripped, §7.1.1 enumerated, §7.3 fixture, 14-callsite guidance) | ✅ hardened |
| 03 | Gemini phantom cacheCreation | gw | minor-gaps | ✅ (audit grep now targets `pNum(tree, '5.9.10')`) | ✅ hardened |
| 04 | upsert shrink-guard | nest | minor-gaps | ✅ (diff-scoped audit grep, schema refs 1087/1088/1129, null-usage refuse test) | ✅ hardened |
| 05 | CC idle-flush orphan-drop | nest | **solid** | n/a | ✅ as-authored |
| 06 | Codex re-attach guard | nest | **solid** | n/a | ✅ as-authored |
| 07 | Claude Desktop version resolution | nest + gw | minor-gaps | ✅ (`records[0].agent`, `p-2` boundary, `services/` path, "Five anchors") | ✅ hardened |
| 08 | Cursor collection (DEFERRED) | nest + gw | material-gaps | ✅ (gauge fields now optional, "latest non-null", five) | ✅ hardened (parked) |
| 09 | deterministicRecordId hardening | nest | **solid** | n/a | ✅ as-authored |
| 10 | web KPI label + Cursor null display | web | **solid** | n/a | ✅ as-authored |
| 11 | prod backfill / re-parse | ops | material-gaps | ✅ (baseArgs `limit: null`, `orderBy`, count-line replace, 5 matches→limited sites) | ✅ hardened |

All 11 plans exist, each source-verified against the real repos with `file:line` citations, each
in the exemplar structure (TL;DR, hard rules, mental model + worked example, exact find/replace
change spec, copy-paste tests, commands, audit greps, hand-back template, acceptance criteria,
out-of-scope + deps).

---

## 2. Shared-file coordination matrix (the real integration risk)

| File | Phases | Overlap? | Resolution |
|---|---|---|---|
| `codex/services/codex-parse-chat.service.ts` | **2** (accumulator + `flushOpenTurn` anchor) and **6** (`task_started` guard clause) | Same file, **different regions** | No line conflict. Stacked order 2→6: P6 layers its guard onto P2's file. Neither touches the other's region; both read `acc.lastEmittedTurnId` consistently (P6 reads, P2 leaves untouched). |
| `telemetry/metric-kind-registry.ts` | **4, 5, 6, 9** each add one counter | Same file, additive lines | All four metric names are **distinct** (`agent_gateway_parse_shrink_rejected_total`, `agent_gateway_parser_orphan_dropped_total`, `agent_gateway_parser_reattach_dropped_total`, `agent_gateway_parser_record_id_hash_downgraded_total`). Alphabetical additions → trivial merges. Registration is mandatory (an existing spec scans `src/` and fails on unregistered names). |
| `claude-code/services/claude-code-parse-chat.service.ts` (+ its spec) | **5** (source: orphan-drop counter) and **7** (adds a test to the spec) | Source vs spec | No logic conflict. Coordinate the spec-file region (both append tests). P5 is a build-order dependency of P7 anyway. |
| `agent-gateway/parse/services/parse-batch-upsert.service.ts` | **4** edits the `ON CONFLICT` WHERE; **11** depends on its behavior (does not edit it) | Edit vs depend | See §3 — this is the load-bearing interaction. |

No two plans prescribe conflicting edits to the same lines.

---

## 3. Load-bearing cross-phase interactions

1. **Phase 4 shrink-guard ↔ Phase 11 backfill (the most important catch).** Phase 4 tightens the
   upsert WHERE to refuse a token-shrinking UPDATE using **strict `>`** on the watermark. Phase 11's
   re-parse of a *dormant* chat produces an **equal** watermark → the corrected tokens are **silently
   vetoed and NOT written**. The spec/ROADMAP's "the UPSERT replaces each row idempotently" is only
   true for strictly-larger-watermark rows. Phase 11's plan surfaces this and forces a heal-strategy
   decision (A: operator DELETE-then-reparse, with the `BreadcrumbRecord onDelete: Cascade` blast
   radius; B: naive reparse-only, which leaves dormant rows stale; C: a guarded equal-watermark
   token-heal branch). **This must be decided before the backfill runs.** Verification must be a
   before/after token spot-check, not "the queue drained" (parser_version advances even on vetoed rows).

2. **Phase 1 → Phase 7 (Desktop inherits the CC pipeline).** Phase 7 lights up the Claude Code parser
   for Desktop, so it inherits Phase 1 (gateway `isUsageBearingAssistantRecord`, which must be exported
   from `sources/claude-code`; nest cache_creation fold) and Phase 5 (orphan-drop). Build order: 1, 4,
   5 merged before 7. Phase 7 also needs its own one-line gateway change (apply the Phase-1 union to
   `claude-desktop/collect.ts`, which has its OWN collector) and a `claude-desktop/v2` sentinel in the
   version scheme — `semver.valid('v2') === null`, so a naive Gemini-style prefix-strip would silently
   fail (caught and corrected in the plan).

3. **Phase 3 → Phase 10 (semantic, not code).** Phase 10's "Token Usage" KPI already excludes
   `cacheCreation`, so it compiles/tests standalone; it depends on Phase 3 only for the underlying data
   to be correct. Cursor "not captured" detection is by **agent identity**, not null-value (the backend
   already COALESCEs to 0).

---

## 4. Build order (stacked integration branch)

```
1 (done) ─┬─> 4 ─┬─> 5 ──┬─> 7 ──┐
          │      └─> 6    │       │
2 ────────┼─────────────┼───────┤
3 ────────┼─────────────┼───> 10 │
9 ────────┘             │        │
                        └────────┴─> 11 (re-parse; needs 2,3,5,7 DEPLOYED, benefits from 4,6)
8 = DEFERRED (parked)
```

Nothing merges to prod until the whole integration branch is complete and verified (per the ROADMAP
merge model). Phase 11 is the only step that runs against prod, and only after the big merge, operator-run.

---

## 5. Residual risks & recommendations

- **Decide Phase 11's heal strategy (A/B/C) before backfill** — this is the single open product decision
  with operational blast radius (§3.1). Recommend B-first (clean for the Desktop-populate + growing-chat
  cases) then operator `go` on A or C for dormant rows.
- **Confirm the flagged per-plan decisions** at implementation time: P2 keeps `tokens_are_estimated:false`
  + a **required** anchor field (production safety; ~14 test call sites get `priorCumulativeUsage: null`);
  P4 reject-not-merge; P5 ship Stage-A counter, defer Stage-B recovery; P8 Option-A-only (billed columns
  stay null) and remains DEFERRED.
- **Merge the shared-file phases in roadmap order** (2 before 6; 5 before 7) so the stacked diffs apply
  cleanly; the registry additions (4/5/6/9) are order-independent.
- **F1 is permanently non-backfillable** (CC dialogue-filter drop is pre-S3-upload). Set expectations.

---

## 6. Verdict

The 11 plans are individually deployment-ready and collectively integrated: shared files are touched in
non-conflicting regions, every dependency/build-order is stated and consistent, metric names are distinct,
and the one subtle cross-phase trap (Phase 4's veto vs Phase 11's re-parse) is surfaced with a decision
path. Ready to hand to implementer model(s) phase-by-phase, in the build order above.
