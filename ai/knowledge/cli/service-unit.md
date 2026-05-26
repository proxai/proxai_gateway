# Service Unit Module

`src/cli/service-unit/` owns the **content and on-disk shape** of the service-unit file (plist / unit / XML). It is strictly orthogonal to `src/cli/service-manager/`, which owns the **commands** that register/start that file. The split is intentional: building a unit file is a pure function; talking to `launchctl` / `systemctl` / `schtasks` is I/O.

## Module surface

| File | Exports |
| --- | --- |
| `launchd-plist.ts` | `buildLaunchdPlist(input)`, `defaultLaunchdPlistPath(label?)` |
| `systemd-unit.ts` | `buildSystemdUnit(input)`, `defaultSystemdUnitPath(unitName?)` |
| `scheduled-task-xml.ts` | `buildScheduledTaskXml(input)`, `defaultScheduledTaskXmlPath()`, `defaultScheduledTaskName()`, `encodeScheduledTaskXml(xml)` |
| `writer.ts` | `writeServiceUnit(input)`, `ensureServiceUnitExists(deps)`, types `WriteServiceUnitInput`, `ServiceUnitRecreateConfig`, `EnsureServiceUnitDeps` |
| `index.ts` | re-exports of all four |

The naming "service-unit" rather than "service-file" is borrowed from systemd terminology and applies even to the launchd plist and Windows Task XML, both of which are conceptually "the file the OS service manager loads to learn how to run our process".

## What each builder emits

| Builder | Body kind | Trigger | Restart policy | Process model |
| --- | --- | --- | --- | --- |
| `buildLaunchdPlist` | UTF-8 plist (XML doctype) | `RunAtLoad=true` + `KeepAlive.SuccessfulExit=false` | restart on any non-zero exit | foreground process under launchd |
| `buildSystemdUnit` | UTF-8 ini-style unit | `[Install] WantedBy=default.target` (loaded on user session) | `Restart=on-failure`, `RestartSec=10s` | `Type=simple` |
| `buildScheduledTaskXml` | UTF-16 LE + BOM Task XML | `LogonTrigger` (start when user logs on) | `RestartOnFailure: Interval=PT1M, Count=3` | `Principal LogonType=InteractiveToken`, `RunLevel=LeastPrivilege` |

All three default to `programArgs = ['run']` (i.e. the hidden `run` subcommand is the actual daemon body) and accept a custom `programPath`. The launchd builder optionally takes `stdoutPath` / `stderrPath`; the systemd builder optionally takes `description` / `restartSec`; the Windows builder optionally takes `userId` (defaults to `INTERACTIVE` placeholder).

## The Windows encoding gotcha

`schtasks /Create /XML` requires the XML file to be UTF-16 LE with a byte-order mark. Plain UTF-8 (even with the XML `encoding="UTF-16"` declaration) is rejected with a misleading "the task xml is missing a required element" error. `encodeScheduledTaskXml(xml)` prepends `﻿`, allocates a 2-byte-per-char buffer, and writes each code unit little-endian via `DataView.setUint16(..., true)` (`scheduled-task-xml.ts:78`). `writeServiceUnit` calls it exclusively for `platform === 'win32'`.

## `writeServiceUnit(input)`

`writer.ts:18` is the only function that performs the actual disk write. It:

1. `ensureDir(dirname(serviceUnitPath))` — creates parent dirs at `0o700` on POSIX.
2. Branches on `input.platform`:
   - `win32` → `buildScheduledTaskXml` → `encodeScheduledTaskXml` → `writeAtomic(bytes)`.
   - `darwin` → `buildLaunchdPlist` → `writeAtomic(string)` → `setMode(0o644)`.
   - `linux` → `buildSystemdUnit` → `writeAtomic(string)` → `setMode(0o644)`.
3. Does NOT chmod the Windows path (`setMode` no-ops on win32 anyway).

All writes go through `writeAtomic` (temp + rename) so a crash mid-write never leaves a half-written unit file.

## `ensureServiceUnitExists(deps)`

`writer.ts:52` is the "recreate if missing" helper used by `start` and `restart`. It:

1. Calls `deps.fileExists(serviceUnitPath)` (defaults to `Bun.file(path).exists()`).
2. If present → returns `false`, no-op.
3. If absent → invokes `deps.onRecreate?.()` (the CLI uses this to log `"service unit missing — recreating from current binary"`), then calls the writer (defaults to `writeServiceUnit`) with the current `serviceUnitRecreate` config.

The recreate path matters because users sometimes delete the plist/unit by hand (or `brew` evicts a `LaunchAgent` during cleanup). `start` will rebuild it from the running binary's path rather than refusing to start.

## Lifecycle: unit-file vs in-process service-unit

This file is about the **on-disk unit file**. There is no in-process "service unit" abstraction in `src/cli/service-unit/`. The CLI's runtime lifecycle (start, stop, error) is handled by `service-manager/` calling into OS tools; the only "unit" code in this directory builds the file the OS reads. If a unit file is removed while the daemon is running, the OS service manager keeps the existing process alive but cannot relaunch it on the next reboot — which is why `start`/`restart` recreate it eagerly.

## Tests

Unit-file tests under `cli/service-unit/tests/` assert the emitted body byte-for-byte. The Windows XML test verifies the UTF-16 LE + BOM encoding by inspecting the first two bytes. Tests use string equality on the body, not regex, so any whitespace drift will fail loudly.

[source: src/cli/service-unit/launchd-plist.ts:14,52; src/cli/service-unit/systemd-unit.ts:13,34; src/cli/service-unit/scheduled-task-xml.ts:12,70,78; src/cli/service-unit/writer.ts:18,52; src/cli/cli.constants.ts:11]
