# Platform Detection

The daemon never tracks "operating system" as a runtime concept. It branches on `process.platform` (the Node-style identifier `'darwin' | 'linux' | 'win32'`) at the lowest layer that actually differs (paths, service manager, spawn argv) and lets every higher layer stay platform-agnostic.

## The three supported values

| `process.platform` | OS family | Status |
| --- | --- | --- |
| `darwin` | macOS | Fully supported |
| `linux` | Linux (user systemd) | Fully supported |
| `win32` | Windows 10/11 | Fully supported |
| anything else | (BSDs, Android, etc.) | Hard error — `throw new Error('unsupported platform: ...')` |

`configDir()`, `logDir()`, `controlSocketPath()`, `platformServiceUnitPath()`, `getServiceManager()`, `readMachineUuid()`, and `readBootId()` all `throw` on an unknown platform rather than fall through. The CLI catches that path explicitly: `main.ts` defines `exitUnsupportedPlatform(commandName)` and uses it on `start`, `stop`, `restart`, `uninstall` after a `null` return from `buildPlatformServiceContext`.

## Where the branching lives

The pattern is "one switch, near the leaf". Production code never branches on platform inside business logic — it calls a helper that did the branching once.

| Branch point | What forks | File:line |
| --- | --- | --- |
| `profileRootDir()` / `profileLogDirRoot()` | per-OS directory layout | `core/io/fs/profile.ts:14,34` |
| `buildControlSocketPath()` | unix socket vs named pipe | `core/io/fs/profile.ts:66` |
| `platformServiceUnitPath()` | plist vs systemd unit vs XML | `cli/wiring/platform.ts:11` |
| `getServiceManager()` | launchctl vs systemctl vs schtasks | `cli/service-manager/index.ts:23` |
| `writeServiceUnit()` | unit-file content + encoding | `cli/service-unit/writer.ts:22` |
| `setMode()` / `ensureDir()` | skip chmod on Windows | `core/io/fs/mode.ts:8,28` |
| `openReadWrite()` (sqlite) | skip chmod on Windows | `core/io/sqlite/open.ts:31` |
| `secureLogStream()` | skip chmod on Windows | `core/log/logger.ts:73` |
| `rmRecursive()` | retry on EBUSY only on Windows | `core/io/fs/rm-recursive.ts:29` |
| `readMachineUuid()` | `ioreg` vs `/etc/machine-id` vs `reg query` | `core/system/machine-uuid.ts:28` |
| `readBootId()` | `sysctl` vs `/proc/.../boot_id` vs PowerShell | `core/system/boot-id.ts:27` |
| `replaceBinary()` (upgrade) | stage `.new` on Windows, in-place elsewhere | `services/upgrade/release-fetch.ts:101` (used at `cli/commands/upgrade.ts:152`) |
| `resolveReportDir()` (inspect) | `tmpdir()` on Windows, `/tmp/...` on POSIX | `cli/commands/inspect/report.ts:29` |
| `resolveWindowsUserId(env)` | only invoked on `win32` | `cli/wiring/platform.ts:22` |

## What the daemon does NOT fork on

- Subprocess shell. There is no `/bin/sh` invocation anywhere. Every subprocess is `Bun.spawn(argv, ...)` with an explicit argv array (e.g. `['launchctl', 'print', ...]`), so quoting, escaping, and PATH lookup never differ between platforms.
- Path separator. All path construction goes through `node:path.join` / `dirname`; literal `'/'` never appears in production code. Tests assert with `path.sep`.
- Spawned tool availability. `defaultSpawn` does not call `Bun.which` itself; uninstall sweep does (see cross-platform rules). When a tool is missing on a platform, the caller treats it as "not present" rather than crash.

## Runtime forks vs build-time forks

Everything is runtime. The binary is the same on every host for a given target triple (the release matrix builds five targets — darwin x64/arm64, linux x64/arm64, win32 x64), but a single binary contains the branches for every platform. There is no `#ifdef`-style compile-time exclusion, so a darwin binary technically contains the systemctl/schtasks code paths — they are just unreachable at runtime.

[source: src/core/io/fs/paths.ts:7,23,77; src/cli/wiring/platform.ts:8,15; src/cli/service-manager/index.ts:23; src/cli/service-unit/writer.ts:18; src/core/io/fs/mode.ts:5,11; src/core/io/sqlite/open.ts:25; src/core/log/logger.ts:64; src/core/io/fs/rm-recursive.ts:29; src/core/system/machine-uuid.ts:31; src/core/system/boot-id.ts:32; src/cli/commands/inspect/report.ts:29; src/main.ts:66]
