# CLI Wiring

`src/cli/wiring/` is the project's dependency-injection layer. It is the only place that touches the I/O world (filesystem paths, `process.env`, `Bun.spawn`, real HTTP clients, real prompts) on behalf of CLI commands. Commands themselves accept a `Deps` interface and never call `process.platform` / `homedir()` / `Bun.file` directly.

## The pattern

For every CLI command there is a paired wiring file. `main.ts` calls `buildXxxDeps(...)` (and `buildXxxOptions(...)` when flags need normalization) and passes the result into the command's `runXxx`. Each wiring function is a pure constructor: it reads platform paths from `core/io/fs`, fetches constants from `core/utils` / `services/config`, and instantiates `HttpClient` / `inquirerPrompts` / `consoleOutput`.

| Wiring file | Builds for | Builds options? | Notable inputs |
| --- | --- | --- | --- |
| `setup-deps.ts` | `runSetup` | yes (`buildSetupOptions`) | `serviceUnitPath`, `serviceManager`, `env` (for Windows user-id), HTTP client factory, `profileCtx` |
| `start-deps.ts` | `runStart` | no | `serviceManager`, `serviceUnitRecreate`, `invokeSetup`, `runAutoUpgrade`, `profileCtx` |
| `stop-deps.ts` | `runStop` | no | `serviceManager`, `profileCtx` |
| `restart-deps.ts` | `runRestart` | no | mirror of start-deps minus auto-upgrade, `profileCtx` |
| `run-deps.ts` | `runDaemon` | no | resolved `GatewayConfig`, `abortSignal`, `binaryPath`, `exitProcess`, `profileCtx` |
| `dev-deps.ts` | `runDev` | no | `devModeSentinelPath`, `devCtx`, `devConfigExists`, `devServiceManager`, `verifyKey`, `writeDevConfig`, `registerDevServiceUnit` |
| `status-deps.ts` | `runStatus` | yes | opens `buffer.db` (or skips when no config), `profileCtx`, all sentinel paths via context |
| `tail-deps.ts` | `runTail` | yes | `logDir`, `abortSignal`, `emit` (defaults to `console.log`) |
| `logs-deps.ts` | `runLogs` | no | `bufferPath` → opens buffer DB, exposes query helpers |
| `doctor-deps.ts` | `runDoctor` | no | `serviceManager`, `platform`, `profileCtx` |
| `uninstall-deps.ts` | `runUninstall` | yes | `serviceUnitPath`, `serviceManager`, `sweep`, `binaryRemover`, `pathCleaner`, `installDir`, `profileCtx`, `devServiceManager`, `devCtx` |
| `upgrade-deps.ts` | `runUpgrade` | yes | `binaryPath`, prompts, package version |
| `upgrade-restore-deps.ts` | `runUpgradePostRespawnRestore` | no | `platform` (derives root dir from `profileRootDir()`) |
| `redaction-deps.ts` | `runRedactionTest`, `runRedactionList` | yes | console emit only |
| `auto-upgrade.ts` | helper used by `start-deps` | n/a | wraps `services/upgrade.runAutoUpgrade`, swallows config-load failures |
| `platform.ts` | shared by setup/start/stop/restart/uninstall | n/a | `buildPlatformServiceContext`, `buildServiceUnitRecreate`, `resolveWindowsUserId` |
| `version-string.ts` | top-level `program.version(...)` | n/a | reads `install_source` from `config.toml` synchronously |

## `ProfileContext` threading

Every wiring builder that touches profile-specific paths accepts a `ProfileContext` object. `main.ts` resolves the targeted profile (from `--profile <name>` flag, or using `godMode` to determine the default) and calls `buildProfileContext(profileName)` before passing the result into the builder.

`dev-deps.ts` is the exception: `runDev` needs access to both the `prod` and `dev` profile contexts simultaneously (e.g. to auto-start the dev daemon on `dev on`, or to coordinate both profiles in `dev setup`). `buildDevDeps()` constructs both internally.

The `--profile` default is:
- `'dev'` for `setup`, `logs`, `doctor` when `godMode === true` (CLI perspective follows the dev-mode flag).
- `'prod'` for all other commands, regardless of god mode.

## What `buildPlatformServiceContext` returns

```ts
interface PlatformServiceContext {
  platform: NodeJS.Platform;
  unitPath: string;
  serviceManager: ServiceManager;
}
```

Returns `null` on unsupported platforms. `main.ts` immediately calls `exitUnsupportedPlatform(commandName)` on `null` for commands that genuinely need a service manager. `setup`, `status`, and `tail` accept `null` (they degrade to "service manager unavailable" messaging or skip the manager-derived parts of the snapshot).

`buildPlatformServiceContext` accepts an optional `configDir` override (third argument). `uninstall` passes `profileCtx.configDir` so the Windows scheduled-task XML path resolves to the correct profile directory.

## How `Deps` interfaces stay testable

Every `XxxCommandDeps` interface treats wiring outputs as "supplied from outside". Tests reach in with hand-built deps (often using `silentOutput()`, `scriptedPrompts()`, in-memory sqlite, fake `SpawnFn`) and never call `buildXxxDeps`. This is why the `build*` functions don't appear in any test file — they're production-only glue.

## `invokeSetup` injection

`start-deps` and `restart-deps` accept `invokeSetup: () => Promise<CommandResult>`. `main.ts` constructs this via `invokeSetupInteractive(inputs)` (`setup-deps.ts`), which returns a closure that calls `runSetup(buildSetupDeps(inputs), { installSource: inferInstallSource(...) })`. This indirection lets `start` enter first-time setup if the user runs `start` before `setup` without start needing to know about setup's deps.

## `runAutoUpgrade` injection

`start-deps` receives `runAutoUpgrade: () => Promise<void>`. `main.ts` builds it as a closure around `autoUpgradeFromConfig({ binaryPath, currentVersion, devMode: false, loadConfig: () => loadConfigFromFile(profileCtx.configFilePath), exitProcess: () => process.exit(0) })`. The closure intentionally swallows `loadConfig` errors (`auto-upgrade.ts`) — auto-upgrade is best-effort and must never block `start` from succeeding.

## Windows user-id resolution

`resolveWindowsUserId(env)` (`platform.ts`) builds `<DOMAIN>\<USER>` from `env['USERDOMAIN']` + `env['USERNAME']`, falling back to just `USERNAME`, then to `undefined`. `buildSetupDeps` calls it only when `platform === 'win32'` and warns to the output sink (`"could not detect Windows user id ... using INTERACTIVE placeholder"`) on `undefined`. Test code must pass an explicit `env`; never rely on the harness's ambient environment for assertions.

## Why wiring lives at this seam

The split (`commands/` = pure logic, `wiring/` = side-effectful glue, `main.ts` = argv parsing) means:

- A command's tests need only a `Deps` shape; no `mock.module` of `node:fs`, `bun:sqlite`, or `commander`.
- Adding a new CLI command is mechanical: add `cli/commands/<name>.ts`, add `cli/wiring/<name>-deps.ts`, register in `main.ts`.
- Changing a path (e.g. moving `buffer.db`) updates `ProfileContext` once; every wiring file picks it up from the context object.

[source: src/cli/wiring/setup-deps.ts; src/cli/wiring/start-deps.ts; src/cli/wiring/stop-deps.ts; src/cli/wiring/restart-deps.ts; src/cli/wiring/run-deps.ts; src/cli/wiring/dev-deps.ts; src/cli/wiring/status-deps.ts; src/cli/wiring/tail-deps.ts; src/cli/wiring/logs-deps.ts; src/cli/wiring/doctor-deps.ts; src/cli/wiring/uninstall-deps.ts; src/cli/wiring/upgrade-deps.ts; src/cli/wiring/upgrade-restore-deps.ts; src/cli/wiring/redaction-deps.ts; src/cli/wiring/auto-upgrade.ts; src/cli/wiring/platform.ts; src/cli/wiring/version-string.ts; src/main.ts; src/core/io/fs/profile.ts]
