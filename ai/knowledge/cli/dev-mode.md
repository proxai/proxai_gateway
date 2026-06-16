# Dev Mode

Dev mode is an explicit, boot-scoped CLI-perspective toggle. It is NOT tied to config existence or daemon lifecycle.

## Two daemons, independently running

`prod` and `dev` each have their own service unit, `config.toml`, `buffer.db`, sentinels, logs, and control socket. Both can run simultaneously with no interaction. The dev daemon captures local coding-agent activity to a local Nest instance (`http://localhost:3001` by default) at all times when it is configured and running — regardless of whether the CLI is in dev mode.

## The dev-mode flag

The flag is stored as a boot-scoped sentinel: the root `DEV_MODE` file at `<profileRootDir>/DEV_MODE` (outside both `prod/` and `dev/` subdirs). It stores `{ bootId: "<current boot id>" }`.

`readDevModeSentinel(path)` reads and validates this file:
- No file → `false`.
- File with matching `bootId` → `true`.
- File with mismatched `bootId` (i.e. the machine rebooted since the flag was set) → preserves the file and returns `false`.
- Malformed JSON → preserves the file and returns `false`.

The CLI is "in dev mode" iff the flag is present **and** its boot id matches the live value. A reboot automatically exits dev mode.

## What the flag controls

The flag controls CLI **perspective** only:

1. **Dev-mode command & option visibility.** When `isDevMode === true`, the dev-only commands (`dev`, `xstate`, `tail`, `inspect`, `redaction`, `replay`) become visible in `--help` (the internal `run` command is always hidden regardless of mode), and the dev-only options become visible: `--profile (prod | dev)` on every command, plus `--all` and `--compact` on `status` (and `--compact` on `logs`). When dev mode is **off** a regular user must see **zero** dev surface area — no dev commands, no `--profile`, no `--all`, no `--compact`. `--profile` is hidden via a post-registration `Option.hideHelp(true)` sweep over `program.commands` (NOT unregistered) so the service-manager-invoked `run --profile <name>` still parses; `--all`/`--compact` are simply not registered when dev mode is off. Evaluated once at `main.ts` startup.
2. **Default profile for commands.** `setup`, `logs`, and `doctor` default to the `dev` profile when in dev mode. All other commands still default to `prod`; use `--profile dev` to override.
3. **Status detail level.** `status` shows both prod and dev profiles with full detail when in dev mode (equivalent to `--all`).

The flag does NOT gate the daemon loops, does NOT pause capture, and does NOT start/stop either daemon on its own.

## `dev` command actions

`dev on`:
1. Write `DEV_MODE` sentinel with `{ bootId: readBootId() }` via `writeAtomic`.
2. If `dev/config.toml` exists and the dev daemon is not already running → start the dev service unit.
3. Print confirmation (notes whether the daemon was started or was already running, or prompts to run `dev setup <KEY>` if no config).

`dev off`:
1. Delete `DEV_MODE` sentinel.
2. Do NOT touch the dev daemon — it keeps running.
3. Print: "Dev mode off. Dev daemon continues running in the background."

`dev` (no argument) — toggle: if flag is set, run `off` path; else run `on` path.

`dev setup <KEY>`:
1. Verify the key against `devCtx.defaultNestBaseUrl/ingestion/verify-key`.
2. Create `devCtx.configDir` if missing.
3. Write `devCtx.configFilePath` with localhost URLs and the provided key.
4. Register the dev service unit.
5. Start the dev daemon.
6. Run the `dev on` path (set the flag, since the user is entering dev mode).
7. Print confirmation.

## Auto-start rule

The dev daemon **auto-starts** whenever a dev config exists:
- On boot (both configured daemons start; dev mode is OFF).
- On soft reinstall (no `--reset`; dev config present → dev daemon starts; dev mode OFF).
- On `dev on` (starts dev daemon if configured).
- After a coordinated upgrade (prod restarts the dev daemon via `.upgrade-restore-state`).

Dev mode itself **never auto-activates** — always requires explicit `dev on`.

## Dev mode and the sentinel rule clarification

The sentinel rule "do not replicate the SESSION_STOPPED boot_id self-clearing pattern" is superseded for `DEV_MODE`. The `DEV_MODE` flag is a sanctioned second user of the boot_id pattern — the rule documents `SESSION_STOPPED` as the original user; `DEV_MODE` is the second. See `ai/knowledge/services/sentinels/sentinel-lifecycle.md` for the full sentinel table.

## What dev mode is NOT

- Not a URL-flip mechanism. The `resolveNestBaseUrl` DEV_MODE URL-flip stopgap from Phase 1 is gone. Each daemon's URL comes from its own profile's `config.toml` `[backend]` section.
- Not config-existence detection. The flag is independent of whether `dev/config.toml` exists.
- Not a daemon lifecycle gate. Daemons start and stop based on service-manager state and `SESSION_STOPPED`, not on the dev-mode flag.
- Not visible to regular users. The `dev` command is hidden (`{ hidden: !isDevMode }`); it does not appear in `--help` or README for prod users.

[source: src/main.ts; src/cli/commands/dev.ts; src/cli/wiring/dev-deps.ts; src/core/io/fs/dev-mode-sentinel.ts; src/core/io/fs/profile.ts]
