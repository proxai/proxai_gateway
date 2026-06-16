# Core System

`src/core/system/` exposes three identity-bearing facts about the host: machine UUID, boot ID, and the derived host-id. All three are per-platform reads, all three are dependency-injectable for tests, and all three throw `GatewayError('fatal', ...)` on unsupported platforms or unparseable output. None of them touch the daemon's own state — they query the OS.

## `readMachineUuid(deps?)`

`machine-uuid.ts:27` — returns the OS-reported hardware identifier as a string. **Stable across reboots, OS reinstalls aside.**

| Platform | Source | Implementation |
| --- | --- | --- |
| `darwin` | `ioreg -rd1 -c IOPlatformExpertDevice`, grep line containing `IOPlatformUUID`, strip quotes | `readDarwin` (line 44) |
| `linux` | first existing of `/etc/machine-id`, `/var/lib/dbus/machine-id` | `readLinux` (line 67) |
| `win32` | `reg query HKLM\SOFTWARE\Microsoft\Cryptography /v MachineGuid`, parse `REG_SZ` field | `readWin32` (line 77) |

The Linux read tries both canonical paths because some container images ship only one. The first non-empty value wins. The Darwin `ioreg` parser tolerates extra quoting (Apple's tool sometimes emits `<"uuid">` instead of `<uuid>`). The Windows `reg` parser splits on `REG_SZ` rather than tabs because the spacing varies between Windows builds.

Errors uniformly take the form `unable to read machine UUID for platform <platform>` with optional `(tool exit N)` suffix.

## `readBootId(deps?)`

`boot-id.ts:27` — returns a hex string that changes on every host reboot. **Used by `SESSION_STOPPED` to detect "the host rebooted while the daemon was stopped, so the sentinel is stale".**

| Platform | Source | Output |
| --- | --- | --- |
| `darwin` | `sysctl -n kern.boottime` → extract `sec=<epoch>` → `sha256Hex('darwin:<epoch>')` | 64-char hex |
| `linux` | read `/proc/sys/kernel/random/boot_id` → trim | UUID-format string |
| `win32` | `powershell -NoProfile -Command "(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToFileTimeUtc()"` → `sha256Hex('win32:<filetime>')` | 64-char hex |

Linux returns the raw boot-id (it's already random per boot). macOS and Windows hash a boot timestamp because the underlying value isn't UUID-shaped. The platform prefix in the hash input (`darwin:`, `win32:`) prevents accidental collisions if a Linux host happened to have the same numeric epoch — defensive only.

`stop` reads this and writes it into the `SESSION_STOPPED` sentinel body. The daemon's `run` command at startup reads the sentinel, compares to the current boot-id, and exits cleanly if they match (user did intend to stop) or clears the sentinel if they differ (reboot wiped intent).

## `deriveHostId(machineUuid, userId)`

`host-id.ts:1` — pure function. Returns `sha256Hex(<trimmed-machine-uuid>:<trimmed-user-id>)`.

The host-id is what the backend uses to identify a unique `(machine, user)` pair. It is computed once at `setup`, written to `config.toml`'s `[account] host_id = ...`, and never recomputed at runtime. `setup new` recomputes it (and re-registers with the backend) because the user-id may have changed.

Machine-uuid alone is insufficient because shared hosts (CI runners, shared dev boxes) have multiple users, each with their own ingestion key. User-id alone is insufficient because a single user across multiple machines should appear as distinct hosts in the dashboard.

## Dependency injection

All three functions accept an optional `deps` object:

| Function | Injectable | Used for |
| --- | --- | --- |
| `readMachineUuid` | `platform`, `spawn`, `readFile` | tests with fake spawn/file readers |
| `readBootId` | `platform`, `spawn`, `readFile` | same |
| `deriveHostId` | — (pure) | n/a |

Tests pass an explicit `platform` to exercise every OS branch from a single host. The default spawn factory (`defaultSpawn`, `defaultBootIdSpawn`) wraps `Bun.spawn` and casts the result to the module-local spawn-result interface — this is the only place in `core/system/` that touches `Bun.spawn`.

## What "system" is NOT

This module deliberately does not expose:

- Process info (PID, parent PID, uptime). Service runtime info comes from `service-manager/<platform>.ts:runtimeInfo` instead.
- CPU / RAM / disk inventories. The daemon does not collect telemetry about the host hardware beyond machine UUID.
- Environment-variable readers. Direct `process.env[...]` access is fine in `cli/wiring/`; this module never reads env vars.

The boundary is "facts the OS reports that the backend needs in order to identify the install". Anything else lives in `cli/` or `services/`.

[source: src/core/system/index.ts:1; src/core/system/machine-uuid.ts:27,44,67,77,107; src/core/system/boot-id.ts:27,48,68,80,105,109; src/core/system/host-id.ts:1]
