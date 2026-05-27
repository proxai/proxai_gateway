# CLI Commands Overview

The CLI is a single `commander` program registered in `src/main.ts`. Each subcommand has a thin `program.command(...)` definition (parses flags, builds platform context, wires deps, calls a `runXxx` function in `src/cli/commands/<name>/`). All command bodies live under `src/cli/commands/`; `src/main.ts` itself is only argv parsing and wiring glue.

## Commands shipped

| Command | Alias | Hidden | Files under `commands/` | Exit codes used |
| --- | --- | --- | --- | --- |
| `setup` | `init` | no | `setup/index.ts` + `key-flow.ts`, `verify-and-register.ts`, `build-config.ts`, `install-and-start.ts` | `ok`, `alreadyInstalled`, `authError`, `validationError` |
| `start` | `s` | no | `start.ts` | `ok`, `error` |
| `stop` | `x` | no | `stop.ts` | `ok`, `error` |
| `restart` | `r` | no | `restart.ts` | `ok`, `error` |
| `run` | — | yes (service-unit only) | `run/index.ts` + `build-contexts.ts`, `run.types.ts` | `ok`, `error` |
| `dev [action]` | `d` | no | `dev.ts` | `ok`, `error` |
| `status` | `i` | no | `status/index.ts` + 8 sibling renderers | `ok`, `notInstalled`, `error` |
| `inspect` | `ins` | no | `inspect/index.ts` + scan/report/layout/spinner/summary | `ok`, `error` |
| `uninstall` | `rm` | no | `uninstall/index.ts` + 4 helpers | `ok`, `alreadyInstalled` |
| `upgrade` | — | no | `upgrade.ts` | `ok`, `error` |
| `tail` | `t` | no | `tail/index.ts` + filter/format/log-path/read | `ok`, `validationError` |
| `redaction test <file>` | — | no | `redaction.ts` (`runRedactionTest`) | `ok`, `fileUnreadable` |
| `redaction list` | — | no | `redaction.ts` (`runRedactionList`) | `ok`, `validationError` |

Aliases come from `cli/command-aliases.ts` and are also wired via `.alias(...)` in `main.ts`. Hidden `run` is the only command the user is not meant to invoke directly — it is the entrypoint launchd / systemd / Task Scheduler calls.

## What each command does (one-liner from the daemon's perspective)

| Command | Responsibility |
| --- | --- |
| `setup` | Validate key, register host-id, write `config.toml`, write service-unit file, optionally `ensureRegistered`+`start`. |
| `start` | Clear `SESSION_STOPPED`, recreate service unit if missing, run auto-upgrade, then `ensureRegistered`+`start` via the service manager. |
| `stop` | Read current boot-id, write `SESSION_STOPPED` sentinel, then `stop` via the service manager. |
| `restart` | Same as `start` minus auto-upgrade, then `restart` instead of `start`. |
| `run` | (hidden) Start the in-foreground daemon — opens buffer DB, builds capture/drain/heartbeat contexts, runs `runDaemonLoops`. |
| `dev` | Toggle the `DEV_MODE` sentinel which forces ingest endpoints to `http://localhost:3001`. |
| `status` | Snapshot health, per-source captures, buffer pressure, sentinel state, last cycle results. Supports `--json`. |
| `inspect` | Dry-run scan of every source. Writes a markdown report and prints summary tables. Never touches the buffer. |
| `uninstall` | Stop + unregister + delete service-unit file. With `--reset` also wipes `configDir` and `logDir` via `rmRecursive`. |
| `upgrade` | Fetch latest GitHub Release asset for current platform/arch, swap binary (in-place POSIX, `.new` on Windows). |
| `tail` | Stream the active structured log file with filters (`--level`, `--source`, `--since`, `--lines`, `--follow`, `--raw`). |
| `redaction test` | Dry-run the redaction pipeline against a local file; print before/after. Local-only. |
| `redaction list` | Enumerate redaction rules, optionally filtered by category or rendered as JSON. |

## Exit code conventions

Defined in `src/cli/cli.constants.ts:1`:

```
ok=0  error=1  validationError=2  authError=3  notInstalled=4
alreadyInstalled=5  fileUnreadable=7
```

Code 6 is intentionally skipped (historical reservation). `130` is reserved for `UserAbortedError` (Ctrl-C through inquirer prompts) and is set in `main.ts:425`. Every command returns a `CommandResult = { exitCode }`; `main.ts` calls `process.exit(result.exitCode)`.

## Wiring layer

Every command has a paired `cli/wiring/<name>-deps.ts` file (see `wiring.md`). `main.ts` never instantiates infrastructure directly — it calls `buildXxxDeps(...)` and passes the result. This is the only architectural seam between argv parsing and command logic.

## Top-level argv handling

- `program.parseAsync()` catches three exception shapes (`UserAbortedError → 130`, `GatewayError → error`, other `Error → error` with stack). Pre-known categories print without a stack; unknown errors include one for diagnosis.
- The version string is built once by `buildVersionString({ version, installSourcePath })` and includes `installed via <source>` parsed from `config.toml`'s `install_source` field.
- `--config <path>` overrides `config.toml` location and is accepted on `run`, `status`, and `tail`.

## Output and prompts

| Helper | File | Use |
| --- | --- | --- |
| `consoleOutput()` | `cli/output.ts:5` | `info` → stdout, `warn`/`error` → stderr with chalk prefix, `success` → stdout with green checkmark |
| `silentOutput()` / `captureOutput()` | `cli/output.ts:14,23` | test sinks |
| `inquirerPrompts()` | `cli/prompts.ts:29` | `askApiKey`, `confirmPhrase`, `confirmUpgrade` with abort detection that maps to `UserAbortedError` |
| `scriptedPrompts(answers)` | `cli/prompts.ts:54` | test sink with pre-recorded answers |

[source: src/main.ts:1,56,423; src/cli/cli.constants.ts:1; src/cli/command-aliases.ts:1; src/cli/commands/index.ts:1; src/cli/commands/setup/index.ts:1; src/cli/commands/start.ts:23; src/cli/commands/stop.ts:16; src/cli/commands/restart.ts:22; src/cli/commands/run/index.ts:29; src/cli/commands/dev.ts:10; src/cli/commands/status/index.ts:24; src/cli/commands/inspect/index.ts:36; src/cli/commands/uninstall/index.ts:21; src/cli/commands/upgrade.ts:31; src/cli/commands/tail/index.ts:20; src/cli/commands/redaction.ts:18,68; src/cli/output.ts:5; src/cli/prompts.ts:29]
