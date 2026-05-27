# Sentinel Lifecycle

Sentinels are zero-or-small content files under `configDir()` whose
**existence** gates loops in the daemon. They are the only out-of-process
coordination channel between the daemon and the CLI commands; the daemon
never reads CLI memory and CLI never reads daemon memory.

## The five sentinels

All paths live under `configDir()`
(`~/.proxai/proxai-gateway/` on POSIX, `%LOCALAPPDATA%/proxai/proxai-gateway/`
on Windows). Source: `src/core/io/fs/paths.ts`.

| File                | Writer                              | Clearer                     | Body                                                  |
| ------------------- | ----------------------------------- | --------------------------- | ----------------------------------------------------- |
| `AUTH_FAILED`       | `handleAuthError` in drain          | `setup --force` only        | `{ reason, detected_at }` JSON                        |
| `BUFFER_FULL`       | `applyPressureSentinel` in capture  | drain when pressure drops   | `{ pending_bytes, threshold, set_at }` JSON           |
| `SESSION_STOPPED`   | `stop` CLI                          | self-clear on boot mismatch | `{ boot_id, set_at }` JSON                            |
| `CONSENT_ACCEPTED`  | `setup` CLI                         | `uninstall --reset`         | informational (never gates)                           |
| `UPDATE_AVAILABLE`  | `runBrewSentinelCheck` (brew only)  | same, on no-update          | `{ latest_version, current_version, detected_at, asset_url? }` JSON |

## File-shape contract

`sentinelHandle(path)` in `core/io/fs/sentinel.ts` is the only writer
abstraction. It:

- `exists()` — single `Bun.file(path).exists()` stat. The gate path uses
  only this method; no body read in hot path.
- `read()` — returns `''` for missing, full text otherwise. Used for
  introspection (`status`, `tail`).
- `write(body)` — calls `writeAtomic` (temp + rename) then `setMode(0o600)`.
  Atomicity guarantees no half-written file is ever observed by `exists()`.
- `remove()` — `unlink` that swallows `ENOENT`. Idempotent.

The atomic write is load-bearing for `AUTH_FAILED` and `BUFFER_FULL` —
the drain loop reads existence on a 30 s tick, and a non-atomic write
could leave a moment where a half-written body is `exists() === true`
but `JSON.parse(body)` would throw. With `writeAtomic`, the rename is
the only transition the kernel exposes.

## Gate order and short-circuit

**Capture cycle** (`capture-cycle.ts`):
1. `AUTH_FAILED` — skip with reason `auth_failed`
2. `BUFFER_FULL` — skip with reason `buffer_full`

First hit short-circuits and emits `capture.cycle.skipped` (INFO).

**Drain cycle** (`drain-cycle.ts`):
1. `AUTH_FAILED` — skip
2. **No `BUFFER_FULL` check.** Drain is the mechanism that *clears*
   `BUFFER_FULL`; gating on it would deadlock.

**Heartbeat cycle** (`heartbeat-cycle.ts`):
1. No sentinel gate. Version checks and auto-upgrade must run even when
   auth is broken or other sentinels are present, otherwise a daemon
   with a revoked key would never self-heal.

## Sentinel placement decisions

- **Why not in `buffer.db`?** Sentinels gate loops *before* opening
  sqlite (cheaper) and survive corruption / re-init of the buffer DB.
- **Why one file per sentinel, not one bitmask file?** Allows atomic
  per-sentinel writes from different code paths without coordination.
- **Why `0o600`?** The `detected_at` timestamps leak machine identity
  and `reason` bodies can include user-supplied text. Restricting to
  owner-read prevents shared-host snooping. Skipped on Windows (chmod
  is a no-op).

## SESSION_STOPPED — the only self-clearing sentinel

Written by `stop` CLI with the current `boot_id` (from
`src/core/system/boot-id.ts`). Read path is
`isCurrentSessionStopped(path, currentBootId)` in
`session-stopped-sentinel.ts`:

- No file → `false`
- File with matching `boot_id` → `true`
- File with **different** `boot_id` → auto-clear and return `false`

The mismatch case fires after a reboot — the user stopped the daemon
deliberately for this boot, but a reboot means a fresh session. The
sentinel evaporates so the daemon starts polling again.

The other start-triggering paths (`start`, `restart`, `setup`,
auto-upgrade respawn, `install.sh` reinstall) also clear
`SESSION_STOPPED` explicitly. The intent is that the application is
always running; `stop` is primarily a developer escape hatch and any
re-start path wins.

## Recovery edge cases

- **Stale binary**: `checkStaleBinary` logs a warning at `pauseAfterDays`;
  the next heartbeat's auto-upgrade replaces the binary in place. There
  is no sentinel involved.
- **Full reset**: `uninstall --reset` + fresh `setup`. This clears all
  sentinels plus `buffer.db` plus `config.toml`.
- **Malformed body**: every reader (`readSessionStoppedSentinel`,
  `readAuthFailedSentinel`, etc.) catches `JSON.parse` errors and
  returns `null` or default. Gate observers only call `exists()`, so a
  corrupted body never throws at the gate.

[source: src/core/io/fs/sentinel.ts, src/core/io/fs/atomic.ts, src/core/io/fs/paths.ts, src/services/polling/capture-cycle.ts, src/services/polling/drain-cycle.ts, src/services/polling/heartbeat-cycle.ts, src/services/polling/*-sentinel.ts]
