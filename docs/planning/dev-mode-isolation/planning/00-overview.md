# Dev-Mode Isolation — Implementation Overview

> **Generated:** 2026-05-27, from brainstorming sessions on 2026-05-26 and 2026-05-27.
>
> **Cross-conversation memory:** `~/.claude/projects/-Users-onurseckinsenoglu-repos-proxai-proxai-gateway/memory/project_dev_mode_isolation.md` is the canonical decision record. Read it first if resuming work in a fresh session.

## Status

| Plan | Phase | Status |
| --- | --- | --- |
| [01](./01-phase-1-foundation.md) | Foundation — ProfileContext, filesystem relocation, `--profile` arg, profile-aware service-unit writers | **DONE** (commits `ea6cc5b`–`a0fbefb`, 2026-05-27) |
| [04](./04-data-model-and-stats.md) | Data-model workstream — extend `upload_receipts`, add `resync_events`, bump retention, derive-from-rows stats, prompt extraction | **DONE** (commits `c709a0d`–`1c9a6dc`, 2026-05-27/28) |
| [02](./02-phase-2-migration-and-dev-daemon.md) | ProfileContext callsite migration + dev service-unit labels + boot-scoped dev-mode flag + `dev` command rewrite + coordinated upgrade + all `--profile` flags + `status` redesign + `logs` command + `doctor` command + remove URL-flip stopgap | **DONE** (commits `7816f0f`–`5df0ebf`, 2026-05-28) |
| [03](./03-phase-3-cleanup-and-surfacing.md) | Delete legacy zero-arg path helpers; surface profile in `status`/`tail`/`uninstall`; update docs and mapper | **DONE** (commits `b527aee`, `71c6f92`, `1a20912`, `a54057a`, 2026-05-28) |

### Phase 1 + data-model commit SHAs

Phase 1:

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
| `41f0846` | fix: auto-upgrade gate |

Data-model workstream:

| SHA | Subject |
| --- | --- |
| `c709a0d` | feat: extend upload_receipts with nullable display+debug columns |
| `45f8a5f` | feat: add resync_events table for watermark-regression visibility |
| `8f49a96` | feat: retain receipts, failed, resync events for one year |
| `e9c6d11` | feat: populate receipt debug columns at delivery |
| `fc22bc0` | feat: record resync events on watermark regression recovery |
| `3f0b82a` | feat: derive upload statistics from rows, drop drift-prone counters |
| `1c9a6dc` | feat: add per-source user-prompt extractor; wire into delivery path |

### Phase 2 commit SHAs

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

### Phase 3 commit SHAs

| SHA | Subject |
| --- | --- |
| `b527aee` | refactor: remove resolveNestBaseUrl and DEV_MODE URL-flip stopgap |
| `71c6f92` | refactor: delete legacy zero-arg path helpers |
| `1a20912` | docs: document dual-daemon dev mode and --profile flag |
| `a54057a` | docs: update ai/knowledge for dual-daemon architecture |

## Goal

Make dev mode a fully-isolated profile that runs **alongside** prod as a second independent daemon process. Each profile has its own platform service unit, `config.toml`, `buffer.db`, sentinels, logs, and control socket. Both daemons can run simultaneously — turning on dev never pauses prod. Auto-upgrade coordinates the two so they converge to the same binary version smoothly in the background.

## Why

Today's "dev mode" is a single `DEV_MODE` sentinel that flips the resolved Nest base URL at module load. After `setup` writes URLs into `config.toml`, the sentinel has no further effect on a running daemon. Buffer DBs, logs, and sentinels are shared between dev and prod. There is no way to keep both keys configured. The fix is two independent daemons, complete isolation, zero impact on prod when working in dev.

## Data-model workstream (parallel track)

A parallel workstream has been split out from Phase 2 into [04-data-model-and-stats.md](./04-data-model-and-stats.md). It does not depend on Phase 2's command-surface restructure and is being implemented now. It covers:

- Extending `upload_receipts` with nullable columns (`user_prompt`, `user_prompt_added_at`, `source_path`, `agent_schema_version`, `gateway_version`, `captured_at_utc`, `attempts`, `source_inode`, `shipped_bytes`).
- New `resync_events` table for watermark-regression recovery visibility.
- Bumping receipt retention to 365 days; failed-batch retention aligned to ~1 year.
- Replacing drift-prone `buffer_metadata` cumulative counters with derive-from-rows stats (COUNT/SUM over `upload_receipts` at read time).
- Per-source option-A prompt extraction at delivery (user's redacted prompt kept; assistant turns stripped).

All changes are additive (ALTER TABLE … ADD COLUMN with `columnExists` guard); no migration framework required.

## Architecture (locked)

1. **Two platform service units.** Prod retains existing labels (`co.proxai.gateway` / `proxai-gateway.service` / `ProxAI Gateway`); dev adds suffix variants (`.dev` / `-dev.service` / ` (dev)`). Both can run concurrently and are managed by their own service-manager instances.

2. **`ProfileContext` object (Approach C from brainstorm)** — the only way to produce profile-derived paths. Single constructor `buildProfileContext('prod' | 'dev')`. All ~65 path-helper callsites migrate to read from a passed context. Existing zero-arg path helpers become thin wrappers in Phase 1 (`buildProfileContext('prod').<field>`), then are deleted in Phase 3.

3. **Daemon's `run` command takes `--profile <name>`** as a CLI argument; service unit's `ProgramArguments`/`ExecStart` embeds the flag. The daemon resolves its profile from the arg at startup — no marker file lookup. Service-manager state is the source of truth for "is this profile running."

4. **One-time filesystem relocation** on first daemon start after upgrade: legacy flat layout files (`~/.proxai/proxai-gateway/{config.toml,buffer.db,sentinels}`) moved into `prod/` subdir via atomic `fs.rename` calls. A `.migrated-flat-to-nested` marker prevents re-runs. A `.migration.lock` file gates concurrent CLI/daemon invocations during the move.

5. **Coordinated auto-upgrade.** Prod is the designated upgrader; dev daemon's heartbeat never calls `autoUpgradeFromConfig`. When prod's heartbeat detects a new release: acquire `.upgrade.lock` → download new binary → if dev running, write `.upgrade-restore-state` with `dev_was_running: true` and stop dev → replace binary atomically → prod exits to respawn → new prod reads restore-state, starts dev if needed, cleans up sentinel, releases lock.

## Tech stack

- **Bun ≥1.3.0** runtime, **TypeScript 6.0.3** source language.
- **bun:sqlite** for buffer DB (already in use; restricted to `src/services/buffer/`).
- **xstate 5.31.1** for state machines (already in use).
- **commander 14** for CLI parsing (already in use).
- **pino 10** + **pino-roll** for logging (already in use).
- **launchd / systemd / Windows scheduled tasks** for service management (all already wired).
- **node:fs.rename** (POSIX atomic on same filesystem) for filesystem relocation.

## Migrations — scope

The filesystem flat→nested relocation in Phase 1 is the only structural migration. Buffer DB schema changes (data-model workstream) are additive-only via `columnExists` ALTER TABLE — no migration framework, no PRAGMA user_version tracking, no recovery CLI. User directive on 2026-05-27. A proper migration system is deferred to a future initiative.

## File location convention

New source files cluster in:

- `src/core/io/fs/profile.types.ts`, `profile.ts` — the ProfileContext module.
- `src/core/io/fs/migrate-flat-to-nested.ts` — one-time relocation.
- `src/services/upgrade/coordinated-upgrade.ts` — Phase 2.
- `src/cli/service-unit/{launchd-plist,systemd-unit,scheduled-task-xml}.ts` extended for profile-aware unit generation.

Tests live in sibling `tests/` directories per project convention.

## Cross-cutting operating rules (apply throughout every phase)

The project's strict rules apply to every task in every plan. Engineers must read and follow these — plans do not restate them inside each task:

- **TypeScript discipline.** No `any`, no `as Type` for object literals, no `!` operator (lint enforces). Use `requireDefined`, `requireString`, `requireNumber`, `requireRecord`, `isRecord`, `isErrnoException`, `errnoCode` from `core/utils/assert.ts` for narrowing `unknown`. Use `unknown` + type guards at boundaries. Use `satisfies Type` over `as Type`. Use `import type` for purely type-only imports.
- **No suppressions.** `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `eslint-disable`, `oxlint-disable`, `v8 ignore` are banned. If a third-party type forces a bridge, isolate the `as unknown as Target` in one helper function whose signature accepts `unknown` and returns the narrowed type.
- **Zero source comments.** Self-documenting code only. Comments allowed only in root `README.md`, CLI help text strings, and terminal output formatting variables.
- **Bun-only package manager.** Use `bun run <script>` for everything. Never `npm`/`yarn`/`pnpm`.
- **Canonical package.json scripts** — never pass raw flags: `bun run check` (lint + format + typecheck), `bun run test:cov` (full coverage), `bun run typecheck`, `bun run format`, `bun run diagrams:export`.
- **TDD enforced per-file** via `bun ai:coverage-orchestrator:validate <file>` — single command that runs 100% coverage gate, type check, lint, and the ban-suppression sweep for one file. Use on every modified or new file before committing.
- **Cross-platform.** No inline `process.platform` checks in business logic; centralize via `src/cli/wiring/platform.ts`. Use `Bun.which()` before `Bun.spawn()`. Use `setModeSilent` from `core/io/fs/mode.ts` for `chmod`. Use `rmRecursive` from `core/io/fs/rm-recursive.ts` for SQLite teardown in tests. No literal `/` in path assertions — use `node:path.sep` or `node:path.join`. Strip ANSI codes with `stripAnsi(s)` before regex assertions on CLI output.
- **Buffer DB.** Only code under `src/services/buffer/` may import `bun:sqlite`. All other modules go through `services/buffer/index.ts` barrel re-exports.
- **Conventional Commits** required, ≤70 char subjects, imperative mood. No `Co-Authored-By` / AI attribution trailers.
- **CalVer versioning** — never hand-edit `package.json` version; always `bun run release`. proxai_gateway uses pure CalVer `YYYY.M.D`. This initiative ships as multiple incremental CalVer releases (one per phase, multiple per phase if PRs are split).

## Sequencing

- Phase 1 is **DONE** — all 9 tasks committed.
- Data-model workstream (04) is **DONE** — all 7 commits landed.
- Phase 2 is **DONE** — all 12 tasks committed (including T7 split into modules + wiring commits).
- Phase 3 is **DONE** — legacy helpers deleted, docs updated, mapper resynced.

All phases are complete. The only remaining work is e2e / runtime verification and the merge to main.

## Resuming work in a future session

The feature is code-complete. To pick up:

1. Read `../README.md` (this folder's parent) for the current state and deferred items.
2. The next steps are: runtime verify the daemon against a local Nest instance, then review + merge the branch to main.
3. If e2e tests are being written as a follow-up phase, start fresh from the branch tip and implement tests only — no code changes needed.
