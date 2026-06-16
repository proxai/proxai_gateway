# File Paths Per Platform

All path resolution is centralized in `core/io/fs/paths.ts`, `core/io/fs/profile.ts`, and `cli/wiring/platform.ts`. Two constants drive the layout: `ORG_NAME = 'proxai'` and `APP_NAME = 'proxai-gateway'` (`core/io/fs/fs.constants.ts`). Everything that touches the filesystem reaches for one of these helpers — there are no hand-rolled `homedir() + '/...'` calls in production code.

## Profile-nested directory layout

The data directories now contain a `prod/` and optionally a `dev/` sub-directory, each representing an independently-running daemon. The outer root dir holds only root-level coordination files.

```
~/.proxai/proxai-gateway/          ← profileRootDir()  (POSIX)
  prod/                            ← buildProfileContext('prod').configDir
    config.toml
    buffer.db  (-wal, -shm)
    AUTH_FAILED
    BUFFER_FULL
    SESSION_STOPPED
    CONSENT_ACCEPTED
    UPDATE_AVAILABLE
    control.sock
    scheduled-task.xml  (win32 only)
  dev/                             ← buildProfileContext('dev').configDir
    (same shape, populated after first `dev setup <KEY>`)
  DEV_MODE                         ← boot-scoped dev-mode flag (root level)
  .upgrade-restore-state           ← coordinated-upgrade state (root level)
  .upgrade.lock                    ← coordinated-upgrade file lock (root level)
  .migration.lock                  ← flat→nested relocation lock (root level)
  .migrated-flat-to-nested         ← one-time relocation marker (root level)
```

### Root-level coordination files

These live at `profileRootDir()`, not inside either `prod/` or `dev/`:

| File | Purpose |
| --- | --- |
| `DEV_MODE` | Boot-scoped dev-mode flag; stores `{ bootId }` for CLI perspective and god-mode visibility |
| `.upgrade-restore-state` | Captures dev-daemon pre-upgrade state (`{ devWasRunning: boolean }`) so the new prod binary can restart dev after respawn |
| `.upgrade.lock` | File lock acquired by coordinated upgrade; prevents concurrent upgrade attempts |
| `.migration.lock` | File lock held during the one-time flat→nested filesystem relocation |
| `.migrated-flat-to-nested` | Written after every file from the old flat layout has been successfully moved into `prod/`; prevents the relocation from re-running |

### ProfileContext

`buildProfileContext(profile: 'prod' | 'dev'): ProfileContext` constructs all paths for a given profile in one place:

```ts
interface ProfileContext {
  name: ProfileName;           // 'prod' | 'dev'
  isDev: boolean;
  configDir: string;           // profileRootDir()/<name>/
  configFilePath: string;      // configDir/config.toml
  bufferDbPath: string;        // configDir/buffer.db
  logDir: string;              // per-platform log dir, profile-specific
  sentinels: {
    authFailed: string;
    bufferFull: string;
    sessionStopped: string;
    consent: string;
    updateAvailable: string;
  };
  controlSocketPath: string;   // configDir/control.sock (POSIX) or named pipe (win32)
  defaultNestBaseUrl: string;  // prod → from PROXAI_GATEWAY_NEST_ENDPOINT or prod URL; dev → http://localhost:3001
}
```

All ~65 former callsites of zero-arg helpers (`configDir()`, `bufferDbPath()`, `*SentinelPath()`) now read from `ProfileContext` fields passed through the call stack.

## The user-data directories

| Kind | macOS | Linux | Windows |
| --- | --- | --- | --- |
| `profileRootDir()` | `~/.proxai/proxai-gateway` | `~/.proxai/proxai-gateway` | `%LOCALAPPDATA%\proxai\proxai-gateway` (fallback `~\AppData\Local\proxai\proxai-gateway`) |
| `configDir` (prod) | `~/.proxai/proxai-gateway/prod` | `~/.proxai/proxai-gateway/prod` | `%LOCALAPPDATA%\proxai\proxai-gateway\prod` |
| `configDir` (dev) | `~/.proxai/proxai-gateway/dev` | `~/.proxai/proxai-gateway/dev` | `%LOCALAPPDATA%\proxai\proxai-gateway\dev` |
| `logDir` (prod) | `~/Library/Logs/proxai/proxai-gateway/prod` | `~/.local/state/proxai/proxai-gateway/log/prod` | `%LOCALAPPDATA%\proxai\proxai-gateway\Logs\prod` |
| `logDir` (dev) | `~/Library/Logs/proxai/proxai-gateway/dev` | `~/.local/state/proxai/proxai-gateway/log/dev` | `%LOCALAPPDATA%\proxai\proxai-gateway\Logs\dev` |
| `controlSocketPath` (POSIX) | `<configDir>/control.sock` | `<configDir>/control.sock` | `\\.\pipe\proxai-gateway-control-<profile>` |

macOS and Linux share `profileRootDir()` (both use `~/.proxai/...`). Windows is the only platform that splits the user-data root from `%LOCALAPPDATA%`. `logDir` differs on every platform and is further split by profile so prod and dev logs never intermingle.

## Files inside each profile's `configDir`

| File | Purpose |
| --- | --- |
| `config.toml` | TOML config written at `setup` |
| `buffer.db` | bun:sqlite buffer DB (+ `-wal`, `-shm`) |
| `AUTH_FAILED` | sentinel |
| `BUFFER_FULL` | sentinel |
| `SESSION_STOPPED` | sentinel (boot-id-aware) |
| `CONSENT_ACCEPTED` | sentinel (informational) |
| `UPDATE_AVAILABLE` | sentinel (brew installs only) |
| `scheduled-task.xml` | Windows service-unit XML (win32 only) |

`DEV_MODE` is explicitly NOT inside either profile dir — it lives at the root so it survives both `prod/` and `dev/` being wiped, and can gate CLI perspective independently of profile state.

## Service-unit files

| Platform | Path (prod) | Path (dev) | Encoding |
| --- | --- | --- | --- |
| `darwin` | `~/Library/LaunchAgents/co.proxai.gateway.plist` | `~/Library/LaunchAgents/co.proxai.gateway.dev.plist` | UTF-8 plist |
| `darwin` (watchdog) | `~/Library/LaunchAgents/co.proxai.gateway.watchdog.plist` | `~/Library/LaunchAgents/co.proxai.gateway.dev.watchdog.plist` | UTF-8 plist |
| `linux` | `~/.config/systemd/user/proxai-gateway.service` | `~/.config/systemd/user/proxai-gateway-dev.service` | UTF-8 systemd unit |
| `linux` (watchdog) | `~/.config/systemd/user/proxai-gateway-watchdog.timer` | `~/.config/systemd/user/proxai-gateway-dev-watchdog.timer` | UTF-8 systemd unit |
| `win32` | `<prod-configDir>/scheduled-task.xml` | `<dev-configDir>/scheduled-task.xml` | UTF-16 LE + BOM (mandatory) |
| `win32` (watchdog) | `<prod-configDir>/scheduled-task-watchdog.xml` | `<dev-configDir>/scheduled-task-watchdog.xml` | UTF-16 LE + BOM (mandatory) |

macOS and Linux unit files live under the OS service-manager directory. The Windows path deliberately lives under the profile's `configDir` (not `LaunchAgents`/`systemd`) because Windows has no equivalent per-user service-config directory.

Each unit's `ProgramArguments` / `ExecStart` / task action includes `--profile <name>` so each daemon process is pinned to its profile at startup.

## Log files

The daemon writes one structured log per day under `logDir` using pino-roll:

- Pattern: `structured.<YYYY-MM-DD>.<N>.log` (e.g. `structured.2026-05-24.1.log`).
- Active stream: opened at daemon start by `createLogger({ logDir })` (`core/log/logger.ts`).
- Mode: `0o600` on POSIX, no chmod on Windows.
- Rolling: daily, retention `LOG_RETENTION_DAYS = 90`, total cap `LOG_TOTAL_SIZE_CAP_BYTES = 5 GiB`.
- `tail` resolves "today's log" via `todaysLogPath(logDir)` and handles midnight rollover by re-resolving on every poll.
- Each profile's logs are in their own sub-directory; `tail --profile dev` reads from the dev log dir.

## Flat-to-nested filesystem relocation

On first run after the initial upgrade that introduced profile nesting, an idempotent step moves the old flat-layout files (that lived directly in `~/.proxai/proxai-gateway/`) into `prod/`. The relocation is:

1. Protected by `.migration.lock` (file lock prevents concurrent CLI/daemon races).
2. Done file-by-file with `fs.rename` (atomic; same filesystem).
3. Marked by `.migrated-flat-to-nested` written only after every file is moved.

If `DEV_MODE` was present in the old flat layout it is **deleted** (not moved) during relocation, since the new `DEV_MODE` lives at the root dir with a different semantic (boot-scoped flag, not URL-flip marker).

## Inspect reports (out-of-tree)

`proxai-gateway inspect` writes a markdown report to `/tmp/proxai-gateway/reports/inspect_<iso>.md` on POSIX or `<tmpdir()>/proxai-gateway/reports/inspect_<iso>.md` on Windows. This is the only file the daemon writes outside `profileRootDir()` / `logDir()`.

## Home-relative paths in config

`expandHome(path)` (`core/io/fs/paths.ts`) accepts `~`, `~/...`, or `~\...` and expands to the user's `homedir()`. Used when config TOML stores user-supplied paths (buffer override, log dir override). Pure paths pass through unchanged — so the daemon accepts both `~/custom-buffer.db` and absolute paths in `[capture] buffer_path = ...`.

[source: src/core/io/fs/paths.ts; src/core/io/fs/profile.ts; src/core/io/fs/profile.types.ts; src/core/io/fs/fs.constants.ts; src/cli/wiring/platform.ts; src/cli/service-unit/launchd-plist.ts; src/cli/service-unit/systemd-unit.ts; src/cli/service-unit/scheduled-task-xml.ts; src/cli/service-unit/dev-labels.ts; src/core/log/logger.ts; src/core/log/log.constants.ts; src/core/io/sqlite/open.ts; src/cli/commands/inspect/report.ts; src/core/io/fs/migrate-flat-to-nested.ts]
