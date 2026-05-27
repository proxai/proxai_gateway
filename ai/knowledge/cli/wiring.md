# CLI Wiring

`src/cli/wiring/` is the project's dependency-injection layer. It is the only place that touches the I/O world (filesystem paths, `process.env`, `Bun.spawn`, real HTTP clients, real prompts) on behalf of CLI commands. Commands themselves accept a `Deps` interface and never call `process.platform` / `homedir()` / `Bun.file` directly.

## The pattern

For every CLI command there is a paired wiring file. `main.ts` calls `buildXxxDeps(...)` (and `buildXxxOptions(...)` when flags need normalization) and passes the result into the command's `runXxx`. Each wiring function is a pure constructor: it reads platform paths from `core/io/fs`, fetches constants from `core/utils` / `services/config`, and instantiates `HttpClient` / `inquirerPrompts` / `consoleOutput`.

| Wiring file | Builds for | Builds options? | Notable inputs |
| --- | --- | --- | --- |
| `setup-deps.ts` | `runSetup` | yes (`buildSetupOptions`) | `serviceUnitPath`, `serviceManager`, `env` (for Windows user-id), HTTP client factory |
| `start-deps.ts` | `runStart` | no | `serviceManager`, `serviceUnitRecreate`, `invokeSetup`, `runAutoUpgrade` |
| `stop-deps.ts` | `runStop` | no | `serviceManager`, session-stopped sentinel path |
| `restart-deps.ts` | `runRestart` | no | mirror of start-deps minus auto-upgrade |
| `run-deps.ts` | `runDaemon` | no | resolved `GatewayConfig`, `abortSignal`, `binaryPath`, `exitProcess` |
| `dev-deps.ts` | `runDev` | no | `DEV_MODE` sentinel path |
| `status-deps.ts` | `runStatus` | yes | opens `buffer.db` (or skips when no config), all five sentinel paths |
| `tail-deps.ts` | `runTail` | yes | `logDir`, `abortSignal`, `emit` (defaults to `console.log`) |
| `uninstall-deps.ts` | `runUninstall` | yes | `serviceUnitPath`, `serviceManager`, `sweep`, `binaryRemover`, `pathCleaner`, `installDir` |
| `upgrade-deps.ts` | `runUpgrade` | yes | `binaryPath`, prompts, package version |
| `redaction-deps.ts` | `runRedactionTest`, `runRedactionList` | yes | console emit only |
| `auto-upgrade.ts` | helper used by `start-deps` | n/a | wraps `services/upgrade.runAutoUpgrade`, swallows config-load failures |
| `platform.ts` | shared by setup/start/stop/restart/uninstall | n/a | `buildPlatformServiceContext`, `buildServiceUnitRecreate`, `resolveWindowsUserId` |
| `version-string.ts` | top-level `program.version(...)` | n/a | reads `install_source` from `config.toml` synchronously |

## What `buildPlatformServiceContext` returns

```ts
interface PlatformServiceContext {
  platform: NodeJS.Platform;
  unitPath: string;
  serviceManager: ServiceManager;
}
```

Returns `null` on unsupported platforms. `main.ts` immediately calls `exitUnsupportedPlatform(commandName)` on `null` for commands that genuinely need a service manager. `setup`, `status`, and `tail` accept `null` (they degrade to "service manager unavailable" messaging or skip the manager-derived parts of the snapshot).

## How `Deps` interfaces stay testable

Every `XxxCommandDeps` interface treats wiring outputs as "supplied from outside". Tests reach in with hand-built deps (often using `silentOutput()`, `scriptedPrompts()`, in-memory sqlite, fake `SpawnFn`) and never call `buildXxxDeps`. This is why the `build*` functions don't appear in any test file — they're production-only glue.

## `invokeSetup` injection

`start-deps` and `restart-deps` accept `invokeSetup: () => Promise<CommandResult>`. `main.ts` constructs this via `invokeSetupInteractive(inputs)` (`setup-deps.ts:112`), which returns a closure that calls `runSetup(buildSetupDeps(inputs), { installSource: inferInstallSource(...) })`. This indirection lets `start` enter first-time setup if the user runs `start` before `setup` without start needing to know about setup's deps.

## `runAutoUpgrade` injection

`start-deps` receives `runAutoUpgrade: () => Promise<void>`. `main.ts` builds it as a closure around `autoUpgradeFromConfig({ binaryPath, currentVersion, devMode: false, loadConfig: () => loadConfigFromFile(), exitProcess: () => process.exit(0) })`. The closure intentionally swallows `loadConfig` errors (`auto-upgrade.ts:21`) — auto-upgrade is best-effort and must never block `start` from succeeding.

## Windows user-id resolution

`resolveWindowsUserId(env)` (`platform.ts:15`) builds `<DOMAIN>\<USER>` from `env['USERDOMAIN']` + `env['USERNAME']`, falling back to just `USERNAME`, then to `undefined`. `buildSetupDeps` calls it only when `platform === 'win32'` and warns to the output sink (`"could not detect Windows user id ... using INTERACTIVE placeholder"`) on `undefined`. Test code must pass an explicit `env`; never rely on the harness's ambient environment for assertions.

## Why wiring lives at this seam

The split (`commands/` = pure logic, `wiring/` = side-effectful glue, `main.ts` = argv parsing) means:

- A command's tests need only a `Deps` shape; no `mock.module` of `node:fs`, `bun:sqlite`, or `commander`.
- Adding a new CLI command is mechanical: add `cli/commands/<name>.ts`, add `cli/wiring/<name>-deps.ts`, register in `main.ts`.
- Changing a path (e.g. moving `buffer.db`) updates `core/io/fs/paths.ts` once; every wiring file picks it up.

[source: src/cli/wiring/setup-deps.ts:36,90,112; src/cli/wiring/start-deps.ts:15; src/cli/wiring/stop-deps.ts:6; src/cli/wiring/restart-deps.ts:14; src/cli/wiring/run-deps.ts:20; src/cli/wiring/dev-deps.ts:5; src/cli/wiring/status-deps.ts:34; src/cli/wiring/tail-deps.ts:10,19; src/cli/wiring/uninstall-deps.ts:20,38; src/cli/wiring/upgrade-deps.ts:10,19; src/cli/wiring/redaction-deps.ts:9,16; src/cli/wiring/auto-upgrade.ts:15; src/cli/wiring/platform.ts:8,15,25,31,41; src/cli/wiring/version-string.ts:12; src/main.ts:97,117,177,233,297]
