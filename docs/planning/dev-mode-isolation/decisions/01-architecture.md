> STATUS: IMPLEMENTED on dev-mode-isolation (2026-05-28). See ../README.md for the commit map.

Planned refactor: make dev mode a fully-isolated profile that runs
**alongside** prod as a second independent daemon process. Each profile
has its own platform service unit, `config.toml`, `buffer.db`,
sentinels, logs, and control socket. Both daemons can run
simultaneously — turning on dev never pauses prod. Auto-upgrade
coordinates the two so they always converge to the same binary version
smoothly in the background.

**Why:** Today's "dev mode" is a single `DEV_MODE` sentinel that only
flips the resolved Nest base URL at module load. After `setup` writes
URLs into `config.toml`, the sentinel has no further effect on a
running daemon. `buffer.db` / logs / sentinels are shared. Flipping
dev mode either ships pending prod batches to localhost or forces a
manual `setup --force` + `restart` dance. There is no way to keep both
keys configured. The user wants complete isolation and zero impact on
prod when working in dev.

**How to apply:** When working on this initiative, the agreed design is:

1. **On-disk layout — nested profile dirs with one-time relocation.**
   `~/.proxai/proxai-gateway/` becomes a parent containing:
   - `prod/` subdir: that profile's `config.toml`, `buffer.db` (+ WAL/
     SHM companions), `AUTH_FAILED`, `BUFFER_FULL`, `SESSION_STOPPED`,
     `CONSENT_ACCEPTED`, `UPDATE_AVAILABLE` sentinels, and
     `control.sock`.
   - `dev/` subdir: same shape, populated only after first `dev setup`.
   - `.upgrade.lock`, `.upgrade-restore-state` (root-level; used during
     coordinated upgrade — see point 6).
   - `.migrated-flat-to-nested` marker so the one-time file relocation
     never re-runs.
   - **SUPERSEDED 2026-05-28 — there IS a dev-mode flag.** This said
     "no marker; service-manager state is truth." User's final model
     reintroduces a BOOT-SCOPED dev-mode flag (root `DEV_MODE`, stores
     boot_id) that controls the CLI *perspective* (command target,
     status detail, god-mode visibility) — distinct from daemon
     lifecycle (daemons run independently of the flag; both auto-start
     on boot with dev mode OFF). Full model in
     [02-commands-and-retention.md](./02-commands-and-retention.md) → "FINAL dev-mode
     model (2026-05-28)".
   - Logs split: `<platform-log-dir>/{prod,dev}/`.
   - On first run after upgrade, an idempotent step renames legacy
     flat-layout files into `prod/`. Uses atomic `fs.rename` (same
     filesystem). Each per-file rename is independently safe; the
     overall marker is written only after every file is moved. A
     `.migration.lock` flock prevents concurrent CLI invocations from
     racing the daemon at startup. **This is the only "migration" in
     scope — purely filesystem relocation, not buffer DB schema work.
     Schema migration framework is explicitly deferred (see point 7).**

2. **Service units — two independent platform registrations.**
   Existing prod unit keeps its current label/name for upgrade
   compatibility:
   - macOS: launchd `co.proxai.gateway` (prod) +
     `co.proxai.gateway.dev` (dev). Plists in
     `~/Library/LaunchAgents/`.
   - Linux: systemd `proxai-gateway.service` (prod) +
     `proxai-gateway-dev.service` (dev). User units in
     `~/.config/systemd/user/`.
   - Windows: scheduled tasks `ProxAI Gateway` (prod) +
     `ProxAI Gateway (dev)` (dev).

   The prod unit is registered at first `setup` (today's behavior,
   unchanged). The dev unit is registered the first time the user runs
   `proxai-gateway dev setup <KEY>`. The unit's `ProgramArguments`
   includes `--profile <name>` (prod/dev), so each daemon process is
   pinned to its profile at startup with no marker file lookup.

3. **Code architecture — Approach C: `ProfileContext` object.**
   `ProfileContext` interface bundles `name` (`'prod' | 'dev'`),
   `isDev`, `configDir`, `configFilePath`, `bufferDbPath`, `logDir`,
   nested `sentinels: { authFailed, bufferFull, sessionStopped,
   consent, updateAvailable }`, `controlSocketPath`,
   `defaultNestBaseUrl`. Single constructor
   `buildProfileContext(profile: 'prod' | 'dev'): ProfileContext`
   resolves all paths once. Each CLI command entry point in `main.ts`
   resolves the targeted profile (from `--profile <name>` flag or
   default = prod; `dev` command can hold both contexts) then calls
   `buildProfileContext()` and passes the resulting context through
   deps. All ~65 callsites of `configDir()` / `bufferDbPath()` /
   `*SentinelPath()` migrate to reading fields off the passed context.

   This was chosen over Approach B (parameterize path helpers with a
   bare `profile` string) for long-term sustainability:
   - Matches existing context-bundle idiom (`PlatformServiceContext`,
     `SetupCommandDeps`).
   - Makes isolation a **structural** property — only
     `buildProfileContext` can produce paths.
   - Composes naturally for operations needing both profiles at once:
     `dev on/off` inspecting target, `uninstall --reset` iterating
     both, the filesystem relocation step holding both contexts.
   - Future-proofs additional profiles without re-auditing every
     callsite.
   - Removes the zero-arg `configDir()` footgun.

4. **CLI command behavior — backward-compatible defaults + new flag.**
   - `setup`, `start`, `stop`, `restart`, `status`, `tail`, `inspect`,
     `replay`, `redaction`, `upgrade` — default to prod when no
     `--profile <name>` flag is given. Existing users see no behavior
     change.
   - `--profile <name>` (or `-p`) — explicit per-command profile
     targeting; works on every command above.
   - `dev on` — register dev unit if not registered, then start dev
     daemon. Equivalent to `start --profile dev` plus the registration
     step on first use.
   - `dev off` — stop dev daemon (does not unregister the unit).
     Equivalent to `stop --profile dev`.
   - `dev` (no arg) — toggle.
   - `dev setup <KEY>` — one-shot sugar: registers dev unit, writes
     `dev/config.toml`, starts dev daemon. Equivalent to
     `setup --profile dev <KEY>` plus the registration.
   - `status --all` — show both daemons side-by-side. Default shows
     only prod.
   - `uninstall` — unregisters both units, leaves both profile dirs
     intact. `uninstall --reset` wipes both profile dirs unconditionally
     (it is the nuclear option).
   - Prod and dev daemons share **nothing** in memory or on disk. Two
     daemons can run simultaneously without interaction.

5. **Rollout — 3 phases, each independently shippable.**
   - **Phase 1.** Introduce `ProfileContext`, `buildProfileContext`,
     filesystem relocation step, `--profile <name>` arg parsing in
     `main.ts`. Existing zero-arg path helpers become thin wrappers
     that internally call `buildProfileContext('prod')` (default to
     prod, behavior preserved). Daemon's `run` command accepts
     `--profile <name>` arg. No new service units yet. No dev daemon
     yet. Behavior observably identical for existing users.
   - **Phase 2.** Migrate the ~65 callsites in dependency order (path
     module → buffer → config → polling → CLI commands → state
     machines). Old zero-arg helpers stay until the last callsite is
     gone. Ship dev service unit registration + `dev` command rewrite
     + `dev setup` sugar + coordinated upgrade flow (see point 6) +
     `--profile` flag on `status`/`tail`/`stop`/etc.
   - **Phase 3.** Delete the bare path helpers (only
     `buildProfileContext` can produce paths). Surface profile
     awareness in user-facing output: `status` shows
     `running (prod)` / `running (dev)`; `status --all` shows both;
     `tail --profile dev` shows dev's log dir.

6. **Coordinated auto-upgrade.** Prod is the designated upgrader; dev
   daemon's heartbeat never calls `autoUpgradeFromConfig` (its
   `profileCtx.isDev` gate keeps it out). When prod's heartbeat
   detects a new release:
   1. Acquire `.upgrade.lock` (file lock). Abort if held.
   2. Download new binary to `<bin>.new`.
   3. Read dev's service-manager status. If dev is running, write
      `.upgrade-restore-state` JSON (`{ dev_was_running: true }`),
      atomic write.
   4. Stop dev daemon synchronously via dev's service-manager stop.
      Poll for exit, 30 s timeout. On timeout: clear sentinel, release
      lock, abort upgrade; retry next heartbeat (safe — prod keeps
      running).
   5. Replace binary atomically (now safe — dev process has exited,
      releasing the binary handle).
   6. Prod exits with `EXIT_CODE.upgradeRespawn`.
   7. Service manager respawns prod under new binary.
   8. New prod daemon's startup: read `.upgrade-restore-state`; if
      `dev_was_running: true` AND `dev/config.toml` exists, start dev
      unit via service manager. Delete the sentinel. Release the lock.
   9. Dev daemon (now started by prod) reads new binary bytes and
      resumes capture.

   Error paths:
   - Network failure during download: never reaches step 3, no
     restore needed.
   - Binary replace fails after step 4: step 8's restore-dev logic
     also runs from the error path, so dev comes back up; prod stays
     on old binary; logs the error; retries next heartbeat.
   - Step 8 fails to start dev: log error, clear sentinel anyway,
     release lock (avoid loops). User runs `dev on` manually when
     they notice.
   - User runs `dev off` during upgrade: ignored. Captured pre-upgrade
     state wins. User re-issues `dev off` post-upgrade if they still
     want dev stopped.
   - Manual `proxai-gateway upgrade` (CLI-triggered): same coordinator
     logic, but starts by also capturing prod's pre-upgrade state
     (since the CLI might be invoked when only one daemon is running).
   - Brew install_source: brew swaps the binary externally; existing
     stale-binary detection (hourly heartbeat) makes each daemon
     respawn under the new binary independently. Slower convergence
     (~1 h worst case) than github_release path; acceptable for brew
     users. Can be tightened later with `fs.watch` on the binary path.

7. **Migrations — explicitly OUT OF SCOPE for this initiative.** The
   filesystem flat→nested relocation in point 1 is the only "migration"
   shipping here. No buffer DB schema migration framework, no config
   TOML versioning, no `PRAGMA user_version` tracking, no recovery
   CLI. The existing `columnExists` ad-hoc pattern in
   `services/buffer/db.ts` continues to work for any incidental
   schema needs. When future data-integrity work requires a proper
   migration system, design and ship it as its own initiative — do
   NOT bundle it with dev-mode isolation. User explicitly directed
   this scope cut on 2026-05-27.

8. **Resolved open details (no longer open):**
   - **Cross-profile flags on `tail` / `status`** → resolved: every
     command takes `--profile <name>` (default prod).
   - **`uninstall --reset` scope** → resolved: wipes both profile
     dirs unconditionally.
   - **Dev URL configurability** → resolved: hardcoded
     `http://localhost:3001` as `devCtx.defaultNestBaseUrl`.
     Editable post-setup via `dev/config.toml`. No CLI flag.
   - **Atomic-switch error handling** → resolved by going dual-daemon:
     there is no atomic "switch" anymore. `dev on/off` is just
     start/stop of an independent service unit. Failures are
     localized.
   - **`dev setup` sugar** → resolved: included.
   - **Cross-profile sentinel observation** → resolved: each daemon
     watches only its own profile dir.
   - **Control socket location** → resolved: per-profile, at
     `<profileCtx.configDir>/control.sock`.

9. **Sequencing constraint** — resolved on 2026-05-27: user merged the
   pause/resume removal to main, pushed/released, and cut the
   `dev-mode-isolation` branch from a clean main. Implementation
   proceeds on that branch.

**Implementation plans** were written 2026-05-27 via the writing-plans
skill to `.tmp/dev-mode-isolation/` (gitignored):
- `00-overview.md` — index, locked architecture, cross-cutting rules,
  sequencing, resume instructions.
- `01-phase-1-foundation.md` — ProfileContext types/constructor,
  filesystem flat→nested relocation, `--profile` arg on `run`,
  profile-aware service-unit writers, legacy-unit auto-rewrite hook.
  9 tasks, TDD, fully detailed. **Ready to execute; independent of the
  pending command restructure.**
- `02-phase-2-migration-and-dev-daemon.md` — ~65-callsite migration to
  ProfileContext (buffer/config/polling/state-machines/wiring), dev
  service unit, `dev` command rewrite, `dev setup` sugar, coordinated
  upgrade flow, uninstall-both. 14 tasks. **Command-shaped tasks (7, 9)
  are flagged placeholders PENDING the user's comprehensive command
  restructure — do not execute until revised.**
- `03-phase-3-cleanup-and-surfacing.md` — delete legacy path helpers,
  surface profile in `status`/`status --all`, tail/inspect honor
  `--profile`, docs + mapper resync. 7 tasks.

If `.tmp/` is cleaned again, regenerate from this memory file (it holds
the full design) by re-running the writing-plans skill. Memory is the
durable cross-conversation backup; the `.tmp/` plans are the
during-implementation source of truth.

Related: see `docs/` (project-wide architecture facts).
