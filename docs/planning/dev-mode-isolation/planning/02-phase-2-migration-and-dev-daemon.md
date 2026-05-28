# Phase 2 — Migration + Dev Daemon + Command Surface

> **STATUS: DONE.**
>
> Phase 1 (ProfileContext foundation, filesystem relocation, `--profile run`) is **done** (`ea6cc5b`–`a0fbefb`).
> Data-model workstream (receipts schema, `resync_events`, retention, derive-from-rows stats, prompt extractors) is **done** (`c709a0d`–`1c9a6dc`).
> Phase 2 is **done** (`7816f0f`–`5df0ebf`, 2026-05-28). All 12 tasks committed. `bun run check` clean; 2286 tests pass.

> **Constraints (applied to every task):**
> - Code-only. e2e testing is a separate later phase.
> - No inline comments in `src/` files (project rule). Self-documenting code only.
> - No `any`, no `!` operator, no `@ts-ignore`/`@ts-expect-error`/`@ts-nocheck`/`eslint-disable`/`oxlint-disable`/`v8 ignore` suppressions.
> - No `{ ... } as Type` object-literal casts. Use variable annotations or `satisfies`.
> - Additive schema changes only. No migration framework.
> - After each task: `bun run check` must stay green; existing test suite must stay green.
> - Do not run the app/daemon/migrations at any point.
> - Conventional Commits, ≤70 char subjects, imperative mood, no AI attribution trailers.

---

## What is already done (do not re-implement)

- `ProfileContext` interface + `buildProfileContext()` constructor (`src/core/io/fs/profile.ts`, `profile.types.ts`).
- Zero-arg path helpers exist as thin prod-defaulting wrappers in `src/core/io/fs/paths.ts` (`configDir()`, `bufferDbPath()`, `configFilePath()`, `logDir()`, all `*SentinelPath()` helpers). These are the migration targets for Tasks 1–3.
- `run` command already parses `--profile <name>` and threads `profileCtx` through `buildRunDeps`.
- Data-model layer: `upload_receipts` nullable columns, `resync_events` table, 365-day retention, derive-from-rows stats, per-source prompt extractors — all landed.
- `DEV_MODE` sentinel still exists as a legacy boot-scoped flag; it is used in `config.constants.ts` (`resolveNestBaseUrl`), `daemon-actors.ts`, `status/index.ts`, `status/gather-snapshot.ts`, `main.ts`, `cli/wiring/run-deps.ts`, `cli/wiring/status-deps.ts`, `cli/wiring/dev-deps.ts`. The old URL-flip behavior it drove is superseded by per-profile config but the sentinel machinery is being REPURPOSED (see Task 5).

---

## Dependency order

All tasks are sequential. The coupling chain is strict:

```
Task 1 (config service + URL constants)
  → Task 2 (wiring callsites)
    → Task 3 (main.ts profile resolution for all commands)
      → Task 4 (dev service-unit labels + service-manager multi-profile)
        → Task 5 (dev-mode FLAG redesign: repurpose DEV_MODE, boot-scoped, god-mode)
          → Task 6 (dev command rewrite: boot flag + daemon lifecycle)
            → Task 7 (coordinated upgrade: upgrade-restore-state + coordinator + heartbeat wiring)
              → Task 8 (uninstall: both profiles)
                → Task 9 (status redesign: dev-flag-aware detail + last-5 uploads + resync line)
                  → Task 10 (logs command: record-centric, buffer.db, watch-mode default)
                    → Task 11 (doctor command: scenario catalog as checkers)
                      → Task 12 (remove resolveNestBaseUrl + old DEV_MODE URL-flip stopgap)
```

---

## Task 1 — Migrate config service and URL constants off zero-arg path helpers

**STATUS: DONE** — `7816f0f` (`refactor: URL constants as builder functions; config service takes explicit paths`)

**Why first:** `config.constants.ts` drives `NEST_BASE_URL` via `resolveNestBaseUrl()` which reads the old `DEV_MODE` file for URL-flipping — the old Phase-1 stopgap. After Task 1 the URL constants are functions that accept a `baseUrl` string, and the stopgap `resolveNestBaseUrl` is isolated but not yet deleted (Task 12 deletes it; removing it here would break callers that haven't been migrated yet).

**Files modified:**
- `src/services/config/config.constants.ts` — add URL-builder functions alongside the existing module-level constants.
- `src/services/config/loader.ts` — replace `configFilePath()` default with an explicit path parameter.
- `src/services/config/validate.ts` — replace `bufferDbPath()` and `logDir()` defaults with explicit injectable defaults.
- `src/services/config/writer.ts` — replace `configFilePath()` default with an explicit path parameter.
- All callers of the URL constants in `src/cli/wiring/setup-deps.ts` and `src/cli/commands/setup/build-config.ts` — switch from the module-level constants to the new URL-builder functions, passing a `baseUrl` sourced from `profileCtx.defaultNestBaseUrl`.

**New URL-builder functions added to `config.constants.ts`:**

```ts
export function nestIngestUrl(baseUrl: string): string {
  return `${baseUrl}/v1/raw_records`;
}

export function nestVerifyKeyUrl(baseUrl: string): string {
  return `${baseUrl}/ingestion/verify-key`;
}

export function nestWatermarksUrl(baseUrl: string): string {
  return `${baseUrl}/v1/watermarks`;
}

export function nestRegisterHostIdUrl(baseUrl: string): string {
  return `${baseUrl}/v1/host-ids/register`;
}
```

---

## Task 2 — Migrate remaining wiring callsites to ProfileContext

**STATUS: DONE** — `fb1c0ec` (`refactor: wiring builders take ProfileContext; drop zero-arg path imports`)

**Files modified:**
- `src/cli/wiring/stop-deps.ts`
- `src/cli/wiring/start-deps.ts`
- `src/cli/wiring/restart-deps.ts`
- `src/cli/wiring/status-deps.ts`
- `src/cli/wiring/uninstall-deps.ts`
- `src/cli/service-unit/scheduled-task-xml.ts`

**Pattern for each file:** Add `profileCtx: ProfileContext` to the `Build*DepsInput` interface. Replace every zero-arg helper call with reads from `inputs.profileCtx`. Remove the zero-arg imports.

---

## Task 3 — Thread `--profile <name>` through every CLI command in `main.ts`

**STATUS: DONE** — `7cb08ec` (`feat: all CLI commands accept --profile <name> flag`)

**Files modified:**
- `src/main.ts` — all command actions except `run` (already done) and `dev` (Task 6 rewrites it).

**Commands updated** (each gains `.option('--profile <name>', ..., 'prod')` + profile resolution in action):
`setup`, `start`, `stop`, `restart`, `status`, `inspect`, `uninstall`, `upgrade`, `tail`, `redaction`, `replay`, `xstate`.

---

## Task 4 — Dev-suffix service-unit labels and service-manager multi-profile support

**STATUS: DONE** — `52511f2` (`feat: dev-suffix service-unit identifiers; service-manager accepts profile`)

**New file:**
- `src/cli/service-unit/dev-labels.ts` — five pure functions: `devLaunchdLabel`, `devSystemdUnitName`, `devWindowsTaskName`, `profileLaunchdLabel(profile)`, `profileSystemdUnitName(profile)`, `profileWindowsTaskName(profile)`.

**Files modified:**
- `src/cli/service-manager/index.ts` — `GetServiceManagerInput` gains `profile?: ProfileName`. Internal label/name derivation calls the new helpers.
- Per-platform manager implementations — any hardcoded label strings replaced with input-derived values.

---

## Task 5 — Repurpose DEV_MODE as the boot-scoped dev-mode flag

**STATUS: DONE** — `bef53fd` (`refactor: DEV_MODE sentinel uses boot-scoped boot_id; add readDevModeSentinel`)

**Why:** The FINAL dev-mode model (confirmed 2026-05-28) repurposes the `DEV_MODE` sentinel. The old use (URL-flip) is dead once per-profile config is in place. The new use: `DEV_MODE` stores the current boot_id (reusing the `readBootId()` / SESSION_STOPPED pattern). CLI is "in dev mode" iff the file exists AND its content matches the current `readBootId()` value. A reboot clears it automatically (boot_id mismatch → file treated as absent and self-cleared). Only `dev on` writes it; only `dev off` deletes it. It controls CLI perspective (command target profile, status detail level, god-mode command visibility) and never controls daemon lifecycle.

**New helper `readDevModeSentinel(sentinelPath: string): boolean`** — reads the file, parses the JSON body `{ bootId: string }`, returns `true` only if `bootId === readBootId()`. Self-clears the file (deletes it) if the boot_id mismatches and returns `false`.

**Files modified:**
- `src/cli/wiring/dev-deps.ts`
- `src/cli/wiring/status-deps.ts`
- `src/cli/wiring/run-deps.ts`
- `src/cli/commands/status/gather-snapshot.ts` and `status/index.ts`
- `src/main.ts`
- `src/services/state-machines/daemon-actors/daemon-actors.ts`
- `src/core/io/fs/migrate-flat-to-nested.ts` — `DEV_MODE` remains in `FILES_TO_DELETE_NOT_MOVE` (no change needed).

---

## Task 6 — Rewrite the `dev` command for the FINAL dev-mode model

**STATUS: DONE** — `9607ac0` (`feat: rewrite dev command for boot-scoped flag + daemon lifecycle`)

**Why:** The current `dev.ts` is the old URL-flip toggle. The new `dev` command is the gateway to the boot-scoped dev-mode flag AND the dev daemon lifecycle. `dev on` sets the flag (writes boot_id) and auto-starts the dev daemon if configured. `dev off` clears the flag and does NOT stop the daemon. `dev setup <KEY>` registers the dev unit, writes `dev/config.toml`, starts the dev daemon. `dev` (no arg) toggles.

**FINAL model invariants (from 2026-05-28 decisions):**
- The flag is set by `dev on`, cleared by `dev off`.
- Daemons auto-start when configured; the flag never auto-activates.
- `dev off` does NOT stop the dev daemon.
- `dev on` does auto-start the dev daemon if configured (`dev/config.toml` exists).
- Boot → both configured daemons start; dev mode OFF.
- `setup` defaults to the current perspective (dev mode ON → `setup dev` default; dev mode OFF → `setup prod` default). Explicit `setup prod` / `setup dev` always override.

**God-mode visibility:** When in dev mode, the commands `dev`, `run`, `xstate`, `tail`, `inspect`, `redaction`, `replay` switch from `{ hidden: true }` to visible. When dev mode is OFF, they are hidden.

**Files modified:**
- `src/cli/commands/dev.ts` — full rewrite.
- `src/cli/wiring/dev-deps.ts` — new `DevCommandDeps` shape.
- `src/main.ts` — (a) read `readDevModeSentinel` at startup to compute `godMode: boolean`; (b) pass `{ hidden: !godMode }` to appropriate commands; (c) replace `dev` command action with new `runDev` dispatch; (d) `setup` default profile derived from dev-mode flag.

---

## Task 7 — Coordinated upgrade: upgrade-restore-state + coordinator + heartbeat wiring

**STATUS: DONE** — `27bfdcc` (`feat: upgrade-restore-state module + coordinated-upgrade orchestrator`) + `b94731d` (`feat: wire coordinated upgrade into heartbeat and daemon startup`)

**New files:**
- `src/services/upgrade/upgrade-restore-state.ts` — `readUpgradeRestoreState`, `writeUpgradeRestoreState`, `deleteUpgradeRestoreState`, `UPGRADE_RESTORE_STATE_FILE` constant, `UpgradeRestoreState` type.
- `src/services/upgrade/coordinated-upgrade.ts` — `coordinatedUpgrade(deps)` orchestrator + `runUpgradePostRespawnRestore(deps)` startup handler.

**Files modified:**
- `src/services/polling/heartbeat-cycle.ts` — replace `autoUpgradeFromConfig` call with `coordinatedUpgrade` when a dev config exists; keep the simple path when no dev config exists.
- `src/main.ts` — in the `run` command action, after `runDaemonStartupRelocation` + `refreshServiceUnitIfLegacy`, call `runUpgradePostRespawnRestore` before starting the daemon loops.

---

## Task 8 — Uninstall: handle both profiles

**STATUS: DONE** — `10a7c5f` (`feat: uninstall handles prod+dev profiles; --reset wipes both`)

**Behavior changes:**

`uninstall` (no `--reset`):
1. If dev service manager reports running: stop dev unit.
2. Unregister dev unit (no-op if not registered).
3. If prod service manager reports running: stop prod unit.
4. Unregister prod unit.
5. Leave both `prod/` and `dev/` dirs intact.

`uninstall --reset` (after confirmation):
1. Stop + unregister both units.
2. Delete `<configRootDir>/prod/`, `<configRootDir>/dev/`, `.migrated-flat-to-nested`, `.upgrade-restore-state`, `.upgrade.lock`, `.migration.lock`.
3. Delete `<logRootDir>/prod/`, `<logRootDir>/dev/`.

**Files modified:**
- `src/cli/commands/uninstall/index.ts` (or `sweep.ts`)
- `src/cli/wiring/uninstall-deps.ts`
- `src/cli/commands/uninstall/confirmation-message.ts`

---

## Task 9 — Status redesign: dev-flag-aware detail level + last-5 uploads + resync note

**STATUS: DONE** — `e66f1ad` (`feat: status shows dev-mode detail, last 5 uploads, resync note`) + `1a25c27` (`feat: status tail/watch-mode default; add --static flag`)

**Status view matrix:**

| Condition | View |
| --- | --- |
| Dev mode OFF (or `DEV_MODE` absent/expired) | Simple prod-only: running state, last cycle, last 5 uploaded records (time + source + prompt snippet + size), pending/failed byte counts |
| Dev mode ON (flag matches boot_id) | Detailed both-profile: prod block + dev block, each with: running state, last cycle, last 5 uploads, pending/failed, resync note |
| `--profile dev` explicit (any dev-mode state) | Dev profile only, detailed |
| `--profile prod` explicit (any dev-mode state) | Prod profile only, simple |

**Last-5 uploads:** `SELECT user_prompt_added_at, source_app, user_prompt, shipped_bytes FROM upload_receipts ORDER BY delivered_at DESC LIMIT 5`. `user_prompt` truncated to ~80 chars. Null fields render as empty string. Label window: "last 12 months". Show captured-vs-uploaded formula. If `idempotent_on_server` count > 0: show "(N re-sent)" footnote.

**Resync note:** `SELECT COUNT(*), MAX(recovered_at) FROM resync_events`. If count > 0: "Re-synced with server: N times, last <TIME>" as informational. If count = 0: omit.

**Files modified:**
- `src/cli/commands/status/status.types.ts`
- `src/cli/commands/status/gather-snapshot.ts`
- `src/cli/commands/status/render-human.ts`
- `src/cli/commands/status/index.ts`
- `src/cli/commands/status/build-json.ts`
- `src/cli/wiring/status-deps.ts`
- `src/services/buffer/index.ts` — added `queryLastUploads(db, limit)` and `queryResyncStats(db)`.

---

## Task 10 — New `logs` command: record-centric view from buffer.db

**STATUS: DONE** — `681c5e3` (`feat: add logs command for record-centric view from buffer.db`) + `b6a49b1` (`fix: logs command dependency wiring`)

**Locked option set:**

| Flag | Meaning |
| --- | --- |
| (none) | Watch mode: last N uploaded records, auto-refreshes |
| `--static` | One-shot render, no watch |
| `--json` | Emit JSON; implies `--static` |
| `--error` | Show failed + quarantined + repeated-resync records only |
| `--source <app>` | Filter by `source_app` |
| `--since <dur>` | Filter by time duration (e.g. `24h`, `7d`) |
| `--pending` | Show queued (not-yet-shipped) records |
| `--lines <n>` | Number of records to show (default 20) |

**Display tiers:**

Prod view (dev mode OFF): `user_prompt_added_at` + `source_app` + `user_prompt` snippet + `shipped_bytes`. No `source_path`, no schema version.

Dev view (dev mode ON or `--profile dev`): all receipt columns.

`--error` view: `upload_batches WHERE status = 'failed'` + `quarantined_records` + any `source_path_hash` appearing > 3 times in `resync_events` within 1 hour. Per-record: `source_app`, `captured_at_utc`, error reason.

**New files:**
- `src/cli/commands/logs/index.ts`
- `src/cli/commands/logs/logs.types.ts`
- `src/cli/commands/logs/gather-records.ts`
- `src/cli/commands/logs/render-logs.ts`
- `src/cli/wiring/logs-deps.ts`

`logs` is prod-visible (no `{ hidden: true }`).

---

## Task 11 — New `doctor` command: reliability-focused scenario checker

**STATUS: DONE** — `5df0ebf` (`feat: add doctor command with reliability-focused scenario checkers`)

**Architecture:** per-scenario pure checker functions `(signals: DoctorSignals) => Finding | null`. Compose them; doctor runs all, sorts by severity.

**Scenarios implemented** (from [../decisions/03-doctor-scenarios.md](../decisions/03-doctor-scenarios.md)):
A1, A2, A3, A4, A5, B1, B2 (THE key disambiguation — B2 with AUTH_FAILED absent is CONFIRMED-network, never bad-key), C1, C2, C3, C4, C5, C6, C7, D1, D2, E1, E2, E3, E4, F1, F2, F3, F4, F5, F6, F7, G1, G2, G3.

**New files:**
- `src/cli/commands/doctor/index.ts`
- `src/cli/commands/doctor/doctor.types.ts`
- `src/cli/commands/doctor/gather-signals.ts`
- `src/cli/commands/doctor/checkers/` (one file per scenario group: lifecycle, auth, upload, capture, binary, filesystem, data-integrity)
- `src/cli/commands/doctor/render-doctor.ts`
- `src/cli/wiring/doctor-deps.ts`

`doctor` is prod-visible (no `{ hidden: true }`).

---

## Task 12 — Remove `resolveNestBaseUrl` and the old DEV_MODE URL-flip stopgap

**STATUS: DONE** — `b527aee` (`refactor: remove resolveNestBaseUrl and DEV_MODE URL-flip stopgap`)

**Files modified:**
- `src/services/config/config.constants.ts` — deleted `resolveNestBaseUrl`, `NEST_BASE_URL`, `NEST_INGEST_URL`, `NEST_VERIFY_KEY_URL`, `NEST_WATERMARKS_URL`, `NEST_REGISTER_HOST_ID_URL`. Kept only the four URL-builder functions (added in Task 1) and all non-URL constants.
- `src/services/config/tests/base-url.test.ts` — updated; tests for DEV_MODE URL-flip logic removed, replaced with tests for URL-builder functions.

---

## Phase 2 end state

All 12 tasks done:

1. Every command accepts `--profile <name>` (default prod). No zero-arg path helper is called outside `src/core/io/fs/paths.ts` (which still exists as the Phase 3 deletion target).
2. The dev-mode flag is boot-scoped, self-clearing on reboot, and controls CLI perspective + god-mode command visibility — not daemon lifecycle.
3. `dev on`/`dev off`/`dev setup`/`dev` toggle fully functional. Daemon starts on `dev on` if configured. Daemon never stops on `dev off`.
4. Dev service unit can be registered independently; two service managers produce independent labels across all three platforms.
5. Coordinated upgrade: prod stops dev → replaces binary → respawn → new prod restarts dev from `.upgrade-restore-state`.
6. `uninstall` stops + unregisters both profiles; `uninstall --reset` wipes both dirs.
7. `status` shows dev-mode-aware detail with last-5 uploads and resync note.
8. `logs` command available to all users: record-centric, watch-mode default, locked option set.
9. `doctor` command available to all users: 30+ scenario checkers, B1/B2 disambiguation enforced, copy-pasteable output.
10. `resolveNestBaseUrl` and module-level URL constants deleted.

Phase 3 (delete legacy zero-arg path helpers; update docs/README; mapper resync) is also DONE — see [03-phase-3-cleanup-and-surfacing.md](./03-phase-3-cleanup-and-surfacing.md).
