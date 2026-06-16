# Service Manager Per Platform

`getServiceManager({ platform, unitPath, spawn? })` is the only public entry point; it returns a uniform `ServiceManager` interface (`isRegistered`, `isRunning`, `ensureRegistered`, `start`, `stop`, `restart`, `unregister`, `runtimeInfo`) backed by whichever native tool the OS ships with. Every implementation talks to its tool via `runCommand(spawn, argv)` — a thin wrapper around `Bun.spawn` that collects stdout/stderr and the exit code.

## What backs each platform

| Platform | Tool | Unit identifier | Unit file path |
| --- | --- | --- | --- |
| `darwin` | `launchctl` (user agent) | `co.proxai.gateway` (label) | `~/Library/LaunchAgents/co.proxai.gateway.plist` |
| `linux` | `systemctl --user` | `proxai-gateway.service` | `~/.config/systemd/user/proxai-gateway.service` |
| `win32` | `schtasks` (per-user Scheduled Task) | `ProxAI Gateway` (task name) | `<configDir>/scheduled-task.xml` |

The label / unit name / task name are constants in `cli/cli.constants.ts:15-17`.

## Install / start / stop / restart / unregister

All three managers obey the same contract; the difference is the argv they emit.

| Operation | macOS (`launchctl`) | Linux (`systemctl --user`) | Windows (`schtasks`) |
| --- | --- | --- | --- |
| `isRegistered` | `launchctl print gui/<uid>/<label>` exit==0 | `list-unit-files <unit>` includes name | `/Query /TN <task>` exit==0 |
| `isRunning` | print includes `state = running` | `is-active <unit>` exit==0 | `/Query ... /FO LIST` contains `Status: Running` |
| `ensureRegistered` | `launchctl bootstrap gui/<uid> <plist>` if not loaded | `daemon-reload`, then `enable <unit>` if not enabled | `/Create /TN <task> /XML <unit> /F` if missing |
| `start` | ensure-loaded, then `launchctl kickstart gui/<uid>/<label>` | reload+enable, then `start <unit>` | ensure-created, then `/Run /TN <task>` |
| `stop` | `launchctl bootout gui/<uid>/<label>` (no-op if not loaded) | `stop <unit>` | `/End /TN <task>` (best-effort, ignores exit) |
| `restart` | ensure-loaded, then `kickstart -k` | reload+enable, then `restart <unit>` | ensure-created, `/End` then `/Run` |
| `unregister` | `launchctl bootout` (no-op if not loaded) | `disable` then `daemon-reload` | `/Delete /TN <task> /F` |
| `runtimeInfo` | parse `pid` and `spawn ts`/`start time` from `print` | parse `MainPID` and `ActiveEnterTimestamp` from `show` | parse `Start Date`+`Start Time` from `/V`; PID via `tasklist /FI "IMAGENAME eq proxai-gateway.exe"` |

## launchctl specifics

- `darwinTarget()` is `gui/<uid>/<label>` where `<uid>` is `process.getuid?.() ?? 0`. The target string is built fresh on every call because tests stub `process.getuid` via spawn injection rather than mocking the path.
- `parseLaunchctlPrint` returns `{ pid: null, startedAt: null }` when `print` fails (e.g. service not loaded); a missing pid is not an error.
- Start uses `kickstart` (re-spawn the program); restart uses `kickstart -k` (kill first, then spawn).

## systemctl specifics

- Always `--user` mode. There is no system-level installation path; the daemon runs as the logged-in user.
- Every state-changing op runs `daemon-reload` first, even `start` and `restart`, in case the unit on disk was edited.
- `is-enabled` non-zero is treated as "needs enabling" (covers both "disabled" and "static"). `enable` is invoked even when the file is freshly written, because the symlink in `default.target.wants` doesn't exist yet.
- `parseSystemctlShow` accepts the `Mon YYYY-MM-DD HH:MM:SS TZ` format `systemctl show` emits for `ActiveEnterTimestamp`. An empty value (service never started) yields `null`.

## schtasks specifics

- `/Create /F` is used unconditionally (force-overwrite). This is safe because the XML is regenerated from current state on every `ensureRegistered`.
- `stop()` deliberately ignores `/End`'s exit code — the task may not be running, but stopping a non-running task should not raise.
- PID resolution is two-step: `schtasks /Query /V` does not include the PID, so when the task is reported as `Running`, the manager additionally runs `tasklist /FI "IMAGENAME eq proxai-gateway.exe" /FO CSV /NH` and parses CSV. If multiple `proxai-gateway.exe` processes exist, the first valid PID wins.
- `parseSchtasksQuery` concatenates `Start Date` and `Start Time` from `/V LIST` output and parses with `Date.parse`. Locale-dependent date formatting is the user's locale (we don't force `/FO TABLE` or set a code page).

## Watchdog specifics

A separate watchdog manager interface exists (`getWatchdogManager({ platform, plistPath, xmlPath, timerName, timerPath, serviceName, servicePath, taskName })` in `cli/watchdog-manager/index.ts`) for managing daemon keep-alive:

- **macOS (`launchctl`):** Plist `~/Library/LaunchAgents/co.proxai.gateway.watchdog.plist` (or dev version) is bootstrapped (`launchctl bootstrap gui/<uid> <plistPath>`) and uninstalled via bootout (`launchctl bootout gui/<uid>/<label>`).
- **Linux (`systemctl --user`):** The watchdog timer (`proxai-gateway-watchdog.timer`) and service (`proxai-gateway-watchdog.service`) are enabled/started with `--now` (`systemctl --user enable --now <timerName>`) and disabled (`systemctl --user disable --now <timerName>`).
- **Windows (`schtasks`):** A per-user Scheduled Task (`ProxAI Gateway Watchdog`) is registered from the generated XML (`schtasks /Create /TN <taskName> /XML <xmlPath> /F`) and deleted (`schtasks /Delete /TN <taskName> /F`).

## Spawning the tool

`defaultSpawn` (in `service-manager/run-command.ts:13`) returns a `SpawnFn` that defers to `Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' })`. Tests inject a fake `SpawnFn` instead of mocking `Bun.spawn`. There is no PATH-resolution step in production — the OS finds `launchctl` / `systemctl` / `schtasks` / `tasklist` itself. If a binary is missing, the spawn fails and the manager reports the failure verbatim.

[source: src/cli/service-manager/index.ts:130; src/cli/service-manager/launchctl.ts:4,16,132; src/cli/service-manager/systemctl.ts:4,143; src/cli/service-manager/schtasks.ts:4,135,148,163; src/cli/service-manager/run-command.ts:3,13; src/cli/service-manager/types.ts:1; src/cli/cli.constants.ts:15; src/cli/watchdog-manager/index.ts:15; src/cli/watchdog-manager/launchctl.ts:17; src/cli/watchdog-manager/systemctl.ts:5; src/cli/watchdog-manager/schtasks.ts:5]
