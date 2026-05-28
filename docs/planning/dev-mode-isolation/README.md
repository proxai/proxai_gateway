# Dev-Mode Isolation — Feature Record

## Summary

This feature replaces the single-daemon "DEV_MODE sentinel flips the Nest URL" model with two fully independent daemon processes — one for prod, one for dev — each with its own service unit, `config.toml`, `buffer.db`, log directory, sentinels, and control socket. A boot-scoped dev-mode flag (not tied to daemon lifecycle) controls the CLI perspective: which profile commands target by default, status detail level, and god-mode command visibility. The two daemons can run simultaneously without interference; turning dev on never pauses prod. A coordinated upgrade flow ensures prod and dev always converge to the same binary version: prod's heartbeat acquires a lock, stops dev, replaces the binary, exits to respawn, and the new prod binary restarts dev from a saved restore-state file. The feature also introduces a new `logs` command (record-centric view from `buffer.db`), a new `doctor` command (reliability-focused scenario checker with 30+ scenarios and guaranteed B1/B2 auth disambiguation), a redesigned `status` (dev-flag-aware detail, last-5 uploads, resync note), derive-from-rows statistics (eliminates drift-prone counters), extended `upload_receipts` schema (nullable display columns, kept redacted user prompts), a new `resync_events` table (watermark-regression visibility), and 1-year retention for receipts/failed batches/resync events.

## Current state

Code-complete on branch `dev-mode-isolation`. `bun run check` is clean. Full test suite: 2286 pass / 0 fail. **e2e / runtime verification is PENDING** — no daemon was run at any point during implementation; runtime verification against a local Nest instance is the deliberately deferred next phase. Branch is NOT pushed, NOT merged.

## Navigation

- `decisions/` — the design decisions and rationale (the "why" and "what"). These are the canonical portable record of every architectural choice made during brainstorming sessions on 2026-05-26/27 and the 2026-05-28 final-model confirmation.
  - `01-architecture.md` — dual-daemon model, ProfileContext (Approach C), filesystem relocation, coordinated upgrade, 3-phase rollout, scope cuts (no migration framework).
  - `02-commands-and-retention.md` — command visibility gating, boot-scoped dev-mode flag (FINAL model), status redesign, `logs` command, `doctor` command, retention reversal (keep redacted prompts 1 year), derive-from-rows stats, upload_receipts schema, resync_events table.
  - `03-doctor-scenarios.md` — comprehensive failure-scenario catalog for the `doctor` command, with definitive signals and disambiguators for every scenario (A through G).

- `planning/` — the phase-by-phase implementation plans. All phases are DONE; plans contain commit SHAs for every task.
  - `00-overview.md` — index, locked architecture, cross-cutting rules, sequencing summary, commit SHA tables.
  - `01-phase-1-foundation.md` — ProfileContext types/constructor, filesystem flat-to-nested relocation, `--profile` arg on `run`, profile-aware service-unit writers, legacy-unit auto-rewrite hook. 9 tasks.
  - `02-phase-2-migration-and-dev-daemon.md` — ~65-callsite migration to ProfileContext, config/URL builders, dev service-unit labels, boot-scoped DEV_MODE flag, `dev` command rewrite, coordinated upgrade, `uninstall` both profiles, `status` redesign, `logs` command, `doctor` command, remove legacy URL-flip stopgap. 12 tasks.
  - `03-phase-3-cleanup-and-surfacing.md` — delete legacy zero-arg path helpers, surface profile in status/tail/inspect output, update docs and mapper. 7 tasks.
  - `04-data-model-and-stats.md` — extended `upload_receipts` schema, `resync_events` table, 1-year retention, derive-from-rows stats, per-source prompt extractors. Parallel workstream.

## Commit map

### Phase 1 (Foundation)

| SHA | Subject |
| --- | --- |
| `ea6cc5b` | feat: add ProfileContext module for dev-mode isolation |
| `1e62732` | refactor: route path helpers through prod ProfileContext |
| `349802b` | fix: make logDir test assertion cross-platform |
| `8fa8afc` | feat: add one-shot flat-to-nested filesystem relocation |
| `b194e55` | feat: thread profileName through service-unit writers |
| `4c2abe6` | feat: daemon run command parses --profile and builds ProfileContext |
| `51ab206` | feat: invoke filesystem relocation at daemon startup |
| `f4c0214` | feat: rewrite legacy service unit args on first daemon start |
| `a0fbefb` | test: e2e smoke for legacy install upgrade to nested layout |
| `41f0846` | fix: auto-upgrade gate (separate fix on the branch) |

### Data-model workstream

| SHA | Subject |
| --- | --- |
| `c709a0d` | feat: extend upload_receipts with nullable display+debug columns |
| `45f8a5f` | feat: add resync_events table for watermark-regression visibility |
| `8f49a96` | feat: retain receipts, failed, resync events for one year |
| `e9c6d11` | feat: populate receipt debug columns at delivery |
| `fc22bc0` | feat: record resync events on watermark regression recovery |
| `3f0b82a` | feat: derive upload statistics from rows, drop drift-prone counters |
| `1c9a6dc` | feat: add per-source user-prompt extractor; wire into delivery path |

### Phase 2 (Migration + Dev Daemon + Command Surface)

| SHA | Subject |
| --- | --- |
| `7816f0f` | refactor: URL constants as builder functions; config service takes explicit paths |
| `fb1c0ec` | refactor: wiring builders take ProfileContext; drop zero-arg path imports |
| `7cb08ec` | feat: all CLI commands accept --profile <name> flag |
| `2f3120d` | chore: gitignore .tmp planning files |
| `52511f2` | feat: dev-suffix service-unit identifiers; service-manager accepts profile |
| `bef53fd` | refactor: DEV_MODE sentinel uses boot-scoped boot_id; add readDevModeSentinel |
| `9607ac0` | feat: rewrite dev command for boot-scoped flag + daemon lifecycle |
| `27bfdcc` | feat: upgrade-restore-state module + coordinated-upgrade orchestrator |
| `b94731d` | feat: wire coordinated upgrade into heartbeat and daemon startup |
| `10a7c5f` | feat: uninstall handles prod+dev profiles; --reset wipes both |
| `e66f1ad` | feat: status shows dev-mode detail, last 5 uploads, resync note |
| `1a25c27` | feat: status tail/watch-mode default; add --static flag |
| `681c5e3` | feat: add logs command for record-centric view from buffer.db |
| `b6a49b1` | fix: logs command dependency wiring |
| `5df0ebf` | feat: add doctor command with reliability-focused scenario checkers |

### Phase 3 (Cleanup)

| SHA | Subject |
| --- | --- |
| `b527aee` | refactor: remove resolveNestBaseUrl and DEV_MODE URL-flip stopgap |
| `71c6f92` | refactor: delete legacy zero-arg path helpers |

### Docs

| SHA | Subject |
| --- | --- |
| `1a20912` | docs: document dual-daemon dev mode and --profile flag |
| `a54057a` | docs: update ai/knowledge for dual-daemon architecture |

## Deferred / next

1. **Write e2e tests** — a separate phase after merge; the implementation was done code-first (TDD unit tests per file) but runtime end-to-end tests against real daemon behavior were deliberately deferred.
2. **Runtime verify against a local Nest** — run the daemon, exercise `dev setup`, `dev on/off`, `status --all`, `logs`, `doctor`, and a simulated upgrade cycle. No daemon was run during implementation.
3. **Review + merge** — the branch is local only; push to origin, open a PR, get review, then merge.

---

_The same decision content also exists in this machine's agent memory (`~/.claude/projects/-Users-onurseckinsenoglu-repos-proxai-proxai-gateway/memory/project_dev_mode_*.md`) but THIS folder is the canonical, portable record — it lives in the repo and is accessible to any agent, teammate, or future session without access to the local memory store._
