# Permissions Per Platform

The daemon runs entirely as the invoking user — never root, never `Administrator`, never a system service account. There is no setuid step, no UAC elevation, and no `sudo` shell-out. Everything in `~/.proxai/proxai-gateway` (POSIX) or `%LOCALAPPDATA%\proxai\proxai-gateway` (Windows) is owned by that user.

## File mode policy (POSIX)

| Path | Mode | Enforced by |
| --- | --- | --- |
| `configDir()` (created on demand) | `0o700` | `ensureDir(path, 0o700)` in `core/io/fs/mode.ts:3` |
| `buffer.db`, `buffer.db-wal`, `buffer.db-shm` | `0o600` | `openReadWrite` calls `setModeSilent` in `core/io/sqlite/open.ts:25-29` |
| Sentinel files (any under `configDir()`) | `0o600` | `sentinelHandle().write` follows `writeAtomic` with `setMode(path, 0o600)` (`core/io/fs/sentinel.ts:18`) |
| Service-unit files (`*.plist`, `*.service`) | `0o644` | `writeServiceUnit` calls `setMode(path, 0o644)` (`cli/service-unit/writer.ts:35`) |
| Active log file | `0o600` | `secureLogStream` chmods on open and `ready` (`core/log/logger.ts:63-79`) |
| Rotated log files | `0o600` | `pruneLogDirectory` chmods survivors (`core/log/prune.ts:53`) |

All chmod calls go through `setMode` (`core/io/fs/mode.ts:10`) or `setModeSilent` (sqlite, log). Both short-circuit on `process.platform === 'win32'` and never throw. `ensureDir` also skips the post-mkdir chmod on Windows. The "silent" variants additionally swallow errors so that a single read-only file in the log directory does not bring the daemon down.

## File mode policy (Windows)

No mode bits are applied. Files inherit ACLs from the parent (`%LOCALAPPDATA%\proxai\proxai-gateway`), which is per-user under Windows defaults. Tightening ACLs on Windows is intentionally not attempted — there is no portable equivalent to `chmod 0600` via `node:fs` that we trust to behave the same across NTFS, FAT (USB drives), and ReFS.

## What permission each operation needs

| Operation | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Read source SQLite files (Cursor, Codex state) | read access to user home | same | same |
| Read source JSONL files (Claude Code, Codex rollouts, Gemini CLI) | read access to user home | same | same |
| Write `configDir`, `logDir`, sentinels | user write | user write | user write |
| Spawn `launchctl` / `systemctl` / `schtasks` | user (no `sudo`) | user (no `sudo`) | user (no UAC) |
| Register `LaunchAgent` | user (writes to `~/Library/LaunchAgents/`) | n/a | n/a |
| Register systemd user unit | n/a | user (writes to `~/.config/systemd/user/`) | n/a |
| Register Scheduled Task | n/a | n/a | user (writes to `<configDir>/scheduled-task.xml` and creates per-user task) |
| Replace own binary on upgrade | user (in-place `unlink`+`write`) | user (in-place `unlink`+`write`) | user (write to `<binary>.new` — running `.exe` is locked) |
| Read machine UUID | user (`ioreg`) | user (read `/etc/machine-id` or `/var/lib/dbus/machine-id`) | user (`reg query HKLM\SOFTWARE\Microsoft\Cryptography MachineGuid`) |
| Read boot id | user (`sysctl kern.boottime`) | user (read `/proc/sys/kernel/random/boot_id`) | user (`Get-CimInstance Win32_OperatingSystem`) |

## What install does NOT do

- It does not elevate. There is no UAC prompt and no `sudo` step. If a user picks an install path that requires elevation (e.g. `/usr/local/bin`), the install fails — we do not auto-retry with elevation.
- It does not write to system service registries (`/Library/LaunchDaemons`, `/etc/systemd/system`, `HKLM`). Everything is per-user.
- It does not chown anything. Mode bits only, no ownership changes.

## Failure modes

| Symptom | Cause | What you'll see |
| --- | --- | --- |
| `EACCES` writing `config.toml` | `~/.proxai/proxai-gateway` owned by another user (rare; usually from running as root once) | `setup` errors via the wrapped `mkdir` / `writeAtomic` |
| `EACCES` writing service-unit file | `LaunchAgents` / `systemd/user` not writable | `start` / `setup` errors; service registration aborts |
| `EBUSY` deleting binary (Windows) | the running gateway holds the lock on its own exe | `upgrade` stages `<binary>.new` instead; user must `stop`, swap, and `start` |
| `EBUSY` removing `buffer.db` on test cleanup (Windows) | sqlite holds the handle | `rmRecursive` GC's and retries up to 10× before giving up |
| Sentinel file unreadable | corrupted by external write | sentinel handle returns `null`/default body — gate observers degrade gracefully (see `services/sentinels.md`) |
| `launchctl` / `systemctl` / `schtasks` missing | non-standard OS image | service-manager call throws; CLI surfaces the underlying stderr |

## Why we don't try harder on Windows perms

Windows lacks a stable per-file `chmod 0600` equivalent across all filesystems users actually deploy on (NTFS, FAT32 thumb drives, ReFS, remote SMB). Rather than ship code that "looks like it sets perms" but silently no-ops on FAT, we deliberately do nothing and rely on `%LOCALAPPDATA%` already being per-user.

[source: src/core/io/fs/mode.ts:3,10; src/core/io/fs/sentinel.ts:18; src/core/io/sqlite/open.ts:25,33; src/core/log/logger.ts:63,74; src/core/log/prune.ts:53; src/cli/service-unit/writer.ts:35; src/core/io/fs/rm-recursive.ts:29; src/core/system/machine-uuid.ts:44,67,77; src/core/system/boot-id.ts:44,64,76; src/cli/commands/upgrade.ts:95]
