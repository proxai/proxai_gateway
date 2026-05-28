# CLI Commands Overview

The CLI is a single `commander` program registered in `src/main.ts`. Each subcommand has a thin `program.command(...)` definition (parses flags, builds platform context, wires deps, calls a `runXxx` function in `src/cli/commands/<name>/`). All command bodies live under `src/cli/commands/`; `src/main.ts` itself is only argv parsing and wiring glue.

## Commands shipped

| Command | Alias | Hidden | Files under `commands/` | Exit codes used |
| --- | --- | --- | --- | --- |
| `setup` | `init` | no | `setup/index.ts` + `key-flow.ts`, `verify-and-register.ts`, `build-config.ts`, `install-and-start.ts` | `ok`, `alreadyInstalled`, `authError`, `validationError` |
| `start` | `s` | no | `start.ts` | `ok`, `error` |
| `stop` | `x` | no | `stop.ts` | `ok`, `error` |
| `restart` | `r` | no | `restart.ts` | `ok`, `error` |
| `run` | — | yes (always) | `run/index.ts` + `build-contexts.ts`, `run.types.ts` | `ok`, `error` |
| `dev [action]` | `d` | yes (god-mode only) | `dev.ts` | `ok`, `error` |
| `xstate` | — | yes (god-mode only) | `run/index.ts` (reuses `runDaemon` with `xstateInspect: true`) | `ok`, `error` |
| `status` | `i` | no | `status/index.ts` + renderers | `ok`, `notInstalled`, `error` |
| `logs` | — | no | `logs/index.ts` + types, gather, render | `ok`, `error` |
| `doctor` | — | no | `doctor/index.ts` + types, signals, checkers, render | `ok`, `error` |
| `inspect` | `ins` | yes (god-mode only) | `inspect/index.ts` + scan/report/layout/spinner/summary | `ok`, `error` |
| `uninstall` | `rm` | no | `uninstall/index.ts` + helpers | `ok`, `alreadyInstalled` |
| `upgrade` | `update` | no | `upgrade.ts` | `ok`, `error` |
| `tail` | `t` | yes (god-mode only) | `tail/index.ts` + filter/format/log-path/read | `ok`, `validationError` |
| `redaction test <file>` | — | yes (god-mode only) | `redaction.ts` (`runRedactionTest`) | `ok`, `fileUnreadable` |
| `redaction list` | — | yes (god-mode only) | `redaction.ts` (`runRedactionList`) | `ok`, `validationError` |
| `replay <logPath>` | — | yes (god-mode only) | `replay/` | `ok`, `error` |

### Visibility model

Commands are divided into two tiers:

**Prod-visible** (always in `--help`): `setup`, `start`, `stop`, `restart`, `status`, `logs`, `doctor`, `upgrade`, `uninstall`.

**Dev-only / god-mode** (`{ hidden: !godMode }` in commander, never appear in prod `--help` or README): `run`, `dev`, `xstate`, `tail`, `inspect`, `redaction`, `replay`.

`godMode` is evaluated once at program startup by reading the `DEV_MODE` boot-scoped flag (`readDevModeSentinel(join(profileRootDir(), 'DEV_MODE'))`). When the flag is present and its `bootId` matches the current `readBootId()`, god mode is active and all dev-only commands become visible. A reboot resets the flag to OFF.

## What each command does (one-liner from the daemon's perspective)

| Command | Responsibility |
| --- | --- |
| `setup` | Validate key, register host-id, write `config.toml`, write service-unit file, optionally `ensureRegistered`+`start`. Defaults to the `dev` profile when in god mode; defaults to `prod` otherwise. |
| `start` | Clear `SESSION_STOPPED`, recreate service unit if missing, run auto-upgrade, then `ensureRegistered`+`start` via the service manager. |
| `stop` | Read current boot-id, write `SESSION_STOPPED` sentinel, then `stop` via the service manager. |
| `restart` | Same as `start` minus auto-upgrade, then `restart` instead of `start`. |
| `run` | (hidden) Start the in-foreground daemon — opens buffer DB, builds capture/drain/heartbeat contexts, runs `runDaemonLoops`. Called by the service unit with `--profile <name>`. |
| `dev` | (god-mode) Manage the boot-scoped dev-mode flag. `on`: set flag, auto-start dev daemon if configured. `off`: clear flag (dev daemon keeps running). `setup <KEY>`: register dev unit, write `dev/config.toml`, start dev daemon, set flag. No arg: toggle. |
| `xstate` | (god-mode) Start the daemon in the foreground with the Stately browser visualiser enabled. |
| `status` | Snapshot health, per-source captures, buffer pressure, sentinel state, last cycle results, and last 5 uploaded records. In god mode (or with `--all`): shows both prod and dev profiles. Supports `--json`. Watch-mode by default. |
| `logs` | Record-centric view from `buffer.db` (`upload_receipts`, `upload_batches`, `resync_events`). Prod view: timestamp, source, prompt snippet, size. Dev view (god mode or `--profile dev`): all receipt columns. Watch-mode by default; `--static` for one-shot. `--error` shows failures/quarantined/regression loops. |
| `doctor` | Read-only reliability checker. Runs the full scenario catalog, labels each finding `CONFIRMED` or `LIKELY`, includes the raw signals appendix. Copy-pasteable output for support. |
| `inspect` | (god-mode) Dry-run scan of every source. Writes a markdown report and prints summary tables. Never touches the buffer. |
| `uninstall` | Stop + unregister both prod and dev units. With `--reset` also wipes both profile dirs, log dirs, and root-level upgrade/migration files. |
| `upgrade` | Fetch latest GitHub Release asset for current platform/arch, swap binary (in-place POSIX, `.new` on Windows). |
| `tail` | (god-mode) Stream the active structured (pino NDJSON) log file with filters (`--level`, `--source`, `--since`, `--lines`, `--raw`). Watch-mode by default; `--static` for one-shot. |
| `redaction test` | (god-mode) Dry-run the redaction pipeline against a local file; print before/after. Local-only. |
| `redaction list` | (god-mode) Enumerate redaction rules, optionally filtered by category or rendered as JSON. |
| `replay` | (god-mode) Replay a JSONL log of state-machine transitions and print the final state per machine. |

## `--profile <name>` flag

Every command accepts `--profile prod` (default) or `--profile dev` to explicitly target a specific profile's service unit, config file, buffer DB, sentinels, and log dir. When in god mode, commands default to the `dev` profile unless overridden.

## Exit code conventions

Defined in `src/cli/cli.constants.ts:1`:

```
ok=0  error=1  validationError=2  authError=3  notInstalled=4
alreadyInstalled=5  fileUnreadable=7
```

Code 6 is intentionally skipped (historical reservation). `130` is reserved for `UserAbortedError` (Ctrl-C through inquirer prompts) and is set in `main.ts`. Every command returns a `CommandResult = { exitCode }`; `main.ts` calls `process.exit(result.exitCode)`.

## Watch-mode defaults

`status`, `logs`, and `tail` all default to live watch mode. Pass `--static` for a one-shot render. `--json` implies `--static` (streaming JSON is not supported).

## Wiring layer

Every command has a paired `cli/wiring/<name>-deps.ts` file (see `wiring.md`). `main.ts` never instantiates infrastructure directly — it calls `buildXxxDeps(...)` and passes the result. This is the only architectural seam between argv parsing and command logic.

## Top-level argv handling

- `program.parseAsync()` catches three exception shapes (`UserAbortedError → 130`, `GatewayError → error`, other `Error → error` with stack). Pre-known categories print without a stack; unknown errors include one for diagnosis.
- The version string is built once by `buildVersionString({ version, installSourcePath })` and includes `installed via <source>` parsed from `config.toml`'s `install_source` field.
- `godMode` is computed at the very top of `main.ts` before `new Command()` so commander can receive static `{ hidden: !godMode }` on the appropriate commands.

## Output and prompts

| Helper | File | Use |
| --- | --- | --- |
| `consoleOutput()` | `cli/output.ts:5` | `info` → stdout, `warn`/`error` → stderr with chalk prefix, `success` → stdout with green checkmark |
| `silentOutput()` / `captureOutput()` | `cli/output.ts:14,23` | test sinks |
| `inquirerPrompts()` | `cli/prompts.ts:29` | `askApiKey`, `confirmPhrase`, `confirmUpgrade` with abort detection that maps to `UserAbortedError` |
| `scriptedPrompts(answers)` | `cli/prompts.ts:54` | test sink with pre-recorded answers |

[source: src/main.ts; src/cli/cli.constants.ts; src/cli/command-aliases.ts; src/cli/commands/index.ts; src/cli/commands/setup/index.ts; src/cli/commands/start.ts; src/cli/commands/stop.ts; src/cli/commands/restart.ts; src/cli/commands/run/index.ts; src/cli/commands/dev.ts; src/cli/commands/status/index.ts; src/cli/commands/logs/index.ts; src/cli/commands/doctor/index.ts; src/cli/commands/inspect/index.ts; src/cli/commands/uninstall/index.ts; src/cli/commands/upgrade.ts; src/cli/commands/tail/index.ts; src/cli/commands/redaction.ts; src/cli/commands/replay; src/cli/output.ts; src/cli/prompts.ts]
