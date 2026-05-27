# File Paths Per Platform

All path resolution is centralized in `core/io/fs/paths.ts` and `cli/wiring/platform.ts`. Two constants drive the layout: `ORG_NAME = 'proxai'` and `APP_NAME = 'proxai-gateway'` (`core/io/fs/fs.constants.ts:1`). Everything that touches the filesystem reaches for one of these helpers — there are no hand-rolled `homedir() + '/...'` calls in production code.

## The user-data directories

| Kind | macOS | Linux | Windows |
| --- | --- | --- | --- |
| `configDir()` | `~/.proxai/proxai-gateway` | `~/.proxai/proxai-gateway` | `%LOCALAPPDATA%\proxai\proxai-gateway` (fallback `~\AppData\Local\proxai\proxai-gateway`) |
| `logDir()` | `~/Library/Logs/proxai/proxai-gateway` | `~/.local/state/proxai/proxai-gateway/log` | `%LOCALAPPDATA%\proxai\proxai-gateway\Logs` |
| `controlSocketPath()` | `<configDir>/control.sock` | `<configDir>/control.sock` | `\\.\pipe\proxai-gateway-control` |

macOS and Linux share `configDir()` (both use a dotted `~/.proxai/...`). Windows is the only platform that splits the user-data root from `%LOCALAPPDATA%`. `logDir()` differs on every platform: macOS follows Apple's `~/Library/Logs/<org>/<app>` convention, Linux follows XDG state hierarchy, Windows nests `Logs/` under the same `%LOCALAPPDATA%` tree as config.

## Files inside `configDir()`

| File | Purpose | Helper |
| --- | --- | --- |
| `config.toml` | TOML config written at `setup` | `configFilePath()` |
| `buffer.db` | bun:sqlite buffer DB (+ `-wal`, `-shm`) | `bufferDbPath()` |
| `AUTH_FAILED` | sentinel | `authFailedSentinelPath()` |
| `BUFFER_FULL` | sentinel | `bufferFullSentinelPath()` |
| `SESSION_STOPPED` | sentinel (boot-id-aware) | `sessionStoppedSentinelPath()` |
| `CONSENT_ACCEPTED` | sentinel (informational) | `consentSentinelPath()` |
| `UPDATE_AVAILABLE` | sentinel (brew installs only) | `updateAvailableSentinelPath()` |
| `DEV_MODE` | sentinel (forces localhost endpoint) | `devModeSentinelPath()` |
| `scheduled-task.xml` | Windows service-unit XML | `defaultScheduledTaskXmlPath()` (win32 only) |

All sentinel files (the five core sentinels plus `DEV_MODE`) live under `configDir()` — never elsewhere. The Windows scheduled-task XML is the only platform-specific artifact that lives in `configDir()`; macOS and Linux unit files live under the OS service-manager directory.

## Service-unit files

| Platform | Path | Owner | Encoding |
| --- | --- | --- | --- |
| `darwin` | `~/Library/LaunchAgents/co.proxai.gateway.plist` | user | UTF-8 plist |
| `linux` | `~/.config/systemd/user/proxai-gateway.service` | user | UTF-8 systemd unit |
| `win32` | `<configDir>/scheduled-task.xml` | user | UTF-16 LE + BOM (mandatory for `schtasks /XML`) |

Resolved by `platformServiceUnitPath(platform)` (`cli/wiring/platform.ts:8`). The Windows path deliberately lives under `configDir()` (not `LaunchAgents`/`systemd`) because Windows has no equivalent per-user service-config directory — `schtasks /Create /XML` accepts a path to any readable file.

## Log files

The daemon writes one structured log per day under `logDir()` using pino-roll:

- Pattern: `structured.<YYYY-MM-DD>.<N>.log` (e.g. `structured.2026-05-24.1.log`).
- Active stream: opened at daemon start by `createLogger({ logDir })` (`core/log/logger.ts:27`).
- Mode: `0o600` on POSIX, no chmod on Windows (`logger.ts:64`).
- Rolling: daily, retention `LOG_RETENTION_DAYS = 90`, total cap `LOG_TOTAL_SIZE_CAP_BYTES = 5 GiB` (`log.constants.ts:10-11`).
- `tail` resolves "today's log" via `todaysLogPath(logDir)` and handles midnight rollover by re-resolving on every poll.

## Watch targets (source files)

`proxai_gateway` watches per-agent local stores; their paths are agent-defined, not gateway-defined. They are out of this slice — see `ai/knowledge/sources/` — but for completeness the gateway consumes them via `<baseDir>/<glob>` patterns where `baseDir` is the agent's own working directory (e.g. `~/.claude/projects`, `~/.codex`, `~/.gemini`, the Cursor `state.vscdb` directory). The gateway only knows about these via `services/polling/default-sources.ts`; it does not synthesize paths in `core/io/fs`.

## Buffer DB sidecar files

`bufferDbPath()` returns the path to `buffer.db`. SQLite's WAL mode adds two siblings: `buffer.db-wal` and `buffer.db-shm`. All three get `chmod 0o600` on POSIX inside `openReadWrite` (`core/io/sqlite/open.ts:25-29`). On Windows they're created with default ACLs (typically inherits-from-parent) — the daemon does not adjust ACLs.

## Inspect reports (out-of-tree)

`proxai-gateway inspect` writes a markdown report to `/tmp/proxai-gateway/reports/inspect_<iso>.md` on POSIX or `<tmpdir()>/proxai-gateway/reports/inspect_<iso>.md` on Windows. This is the only file the daemon writes outside `configDir()` / `logDir()` (`cli/commands/inspect/report.ts:29`).

## Home-relative paths in config

`expandHome(path)` (`core/io/fs/paths.ts:88`) accepts `~`, `~/...`, or `~\...` and expands to the user's `homedir()`. Used when config TOML stores user-supplied paths (buffer override, log dir override). Pure paths pass through unchanged — so the daemon accepts both `~/custom-buffer.db` and absolute paths in `[capture] buffer_path = ...`.

[source: src/core/io/fs/paths.ts:6,22,40,44,48-74,77,88; src/core/io/fs/fs.constants.ts:1; src/cli/wiring/platform.ts:8; src/cli/service-unit/launchd-plist.ts:52; src/cli/service-unit/systemd-unit.ts:34; src/cli/service-unit/scheduled-task-xml.ts:70; src/core/log/logger.ts:27,64; src/core/log/log.constants.ts:10; src/core/io/sqlite/open.ts:25; src/cli/commands/inspect/report.ts:29]
