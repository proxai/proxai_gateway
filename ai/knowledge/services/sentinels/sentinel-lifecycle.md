# Sentinel Lifecycle

Sentinels are zero-or-small content files under each profile's `configDir` (or at `profileRootDir()` for root-level coordination files) whose **existence** gates loops in the daemon. They are the only out-of-process coordination channel between the daemon and the CLI commands; the daemon never reads CLI memory and CLI never reads daemon memory.

## Per-profile sentinels (five per profile)

All five live inside `<profileRootDir>/<profile>/` — i.e. inside `prod/` or `dev/` depending on which daemon writes them. Source: `src/core/io/fs/paths.ts`, resolved via `ProfileContext.sentinels.*`.

| File                | Writer                              | Clearer                     | Body                                                  |
| ------------------- | ----------------------------------- | --------------------------- | ----------------------------------------------------- |
| `AUTH_FAILED`       | `handleAuthError` in drain          | `setup --force` only        | `{ reason, detected_at }` JSON                        |
| `BUFFER_FULL`       | `applyPressureSentinel` in capture  | drain when pressure drops   | `{ pending_bytes, threshold, set_at }` JSON           |
| `SESSION_STOPPED`   | `stop` CLI                          | self-clear on boot mismatch | `{ boot_id, set_at }` JSON                            |
| `CONSENT_ACCEPTED`  | `setup` CLI                         | `uninstall --reset`         | informational (never gates)                           |
| `UPDATE_AVAILABLE`  | `runBrewSentinelCheck` (brew only)  | same, on no-update          | `{ latest_version, current_version, detected_at, asset_url? }` JSON |

## Root-level coordination sentinel: DEV_MODE

`DEV_MODE` lives at `<profileRootDir>/DEV_MODE` — outside both `prod/` and `dev/` subdirectories. It is the boot-scoped dev-mode flag.

| File         | Writer         | Clearer                                       | Body                      |
| ------------ | -------------- | --------------------------------------------- | ------------------------- |
| `DEV_MODE`   | `dev on` CLI   | `dev off` CLI; self-clear on boot_id mismatch | `{ bootId: string }` JSON |

`readDevModeSentinel(path)` is the only reader abstraction. It:
1. Returns `false` if the file is absent.
2. Reads and JSON-parses the body.
3. Compares `bootId` against `readBootId()`.
4. Returns `true` only if they match (same boot session).
5. Self-clears the file (deletes it) if the boot_id mismatches (reboot occurred) or the body is malformed, and returns `false`.

`DEV_MODE` controls CLI perspective (default profile, dev-only command visibility, status detail level) only. It never gates daemon loops.

## Boot-id self-clearing: TWO sanctioned users

The boot_id self-clearing pattern is used by exactly two sentinels:

1. `SESSION_STOPPED` — the original user. Written by `stop` CLI; controls whether the daemon should start after an explicit user stop.
2. `DEV_MODE` — the sanctioned second user. Written by `dev on`; controls CLI perspective mode. Resets to OFF on reboot.

The sentinel rule "do not replicate boot_id self-clearing to other sentinels" applies to all OTHER sentinels — these two are the complete and exhaustive set.

## File-shape contract

`sentinelHandle(path)` in `core/io/fs/sentinel.ts` is the writer/reader abstraction for per-profile sentinels:

- `exists()` — single `Bun.file(path).exists()` stat. The gate path uses only this method; no body read in hot path.
- `read()` — returns `''` for missing, full text otherwise.
- `write(body)` — calls `writeAtomic` (temp + rename) then `setMode(0o600)`. Atomicity guarantees no half-written file is observed by `exists()`.
- `remove()` — `unlink` that swallows `ENOENT`. Idempotent.

`DEV_MODE` uses `writeAtomic` directly (not `sentinelHandle`) for writes and `rmSync` for clears, since it is not a daemon gate but a CLI concern.

## Gate order and short-circuit

**Capture cycle** (`capture-cycle.ts`):
1. `AUTH_FAILED` — skip with reason `auth_failed`
2. `BUFFER_FULL` — skip with reason `buffer_full`

First hit short-circuits and emits `capture.cycle.skipped` (INFO).

**Drain cycle** (`drain-cycle.ts`):
1. `AUTH_FAILED` — skip
2. **No `BUFFER_FULL` check.** Drain is the mechanism that *clears* `BUFFER_FULL`; gating on it would deadlock.

**Heartbeat cycle** (`heartbeat-cycle.ts`):
1. No sentinel gate. Version checks and auto-upgrade must run even when auth is broken or other sentinels are present, otherwise a daemon with a revoked key would never self-heal.

Each daemon observes only its own profile's sentinels — prod never reads dev's sentinels and vice versa.

## Sentinel placement decisions

- **Why not in `buffer.db`?** Sentinels gate loops *before* opening sqlite (cheaper) and survive corruption / re-init of the buffer DB.
- **Why one file per sentinel, not one bitmask file?** Allows atomic per-sentinel writes from different code paths without coordination.
- **Why `0o600`?** The `detected_at` timestamps leak machine identity and `reason` bodies can include user-supplied text. Restricting to owner-read prevents shared-host snooping. Skipped on Windows (chmod is a no-op).
- **Why `DEV_MODE` at root, not inside `prod/`?** It controls CLI perspective, not a daemon behavior. It must survive a `prod/` wipe and must not be confused with a prod-daemon state flag.

## SESSION_STOPPED — self-clearing sentinel (original)

Written by `stop` CLI with the current `boot_id`. Read path is `isCurrentSessionStopped(path, currentBootId)` in `session-stopped-sentinel.ts`:

- No file → `false`
- File with matching `boot_id` → `true`
- File with **different** `boot_id` → auto-clear and return `false`

The mismatch case fires after a reboot — the user stopped the daemon deliberately for this boot, but a reboot means a fresh session. The sentinel evaporates so the daemon starts polling again.

The other start-triggering paths (`start`, `restart`, `setup`, auto-upgrade respawn, `install.sh` reinstall) also clear `SESSION_STOPPED` explicitly. The intent is that the application is always running; `stop` is primarily a developer escape hatch and any re-start path wins.

## Recovery edge cases

- **Stale binary**: `checkStaleBinary` logs a warning at `pauseAfterDays`; the next heartbeat's coordinated upgrade replaces the binary.
- **Full reset**: `uninstall --reset` + fresh `setup`. Wipes both profile dirs, clears all sentinels, `buffer.db`, `config.toml`.
- **Malformed body**: every reader catches `JSON.parse` errors and returns `null` or default. Gate observers only call `exists()`, so a corrupted body never throws at the gate.

[source: src/core/io/fs/sentinel.ts; src/core/io/fs/atomic.ts; src/core/io/fs/paths.ts; src/core/io/fs/profile.ts; src/core/io/fs/dev-mode-sentinel.ts; src/services/polling/capture-cycle.ts; src/services/polling/drain-cycle.ts; src/services/polling/heartbeat-cycle.ts; src/services/polling/*-sentinel.ts]
