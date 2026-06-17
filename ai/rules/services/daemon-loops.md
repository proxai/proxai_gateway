---
name: "Daemon Loop Architecture"
description: "Concurrency rules, independent intervals, capture/drain coordination, and error propagation inside daemon threads."
activation: "contextual"
scenarios: ["Modifying capture, drain, or heartbeat background cycles", "Adjusting daemon sleep intervals or error handling behaviors", "Writing thread concurrency controls or parallel Bun worker flows"]
globs: ["src/**/*.ts", "**/*.ts"]
---

# Daemon Loop Rules


- The four loops (capture, drain, heartbeat, and auth_recovery) run under `Promise.all` wrapped in `superviseLoop` in `runDaemonLoops`. Each loop runs independently and is supervised: if a loop crashes, it is logged and restarted. If a loop crashes consecutively 3 times, the daemon process exits with code 1. They never coordinate in memory — only through SQLite rows and sentinel files.
- Individual cycles (runCaptureCycle, runDrainCycle, runHeartbeatCycle) are executed inside a timeout race (runWithTimeout). If a cycle hangs beyond its threshold (90s for capture, 25s for drain, 600s for heartbeat), it logs a cycle timeout event (*.cycle.timeout) and allows the loop to continue. To prevent concurrent runs of the same loop (duplicate telemetry), a loop tracks its in-flight cycle promise. If the prior promise has not settled yet when the next tick fires, it skips starting a new cycle and logs a skipped event (*.cycle.skipped_in_flight).
- Loop intervals (`CAPTURE_INTERVAL_MS = 120_000`, `DRAIN_INTERVAL_MS = 30_000`, `HEARTBEAT_INTERVAL_MS = 3_600_000`) are constants in `polling.constants.ts` and are deliberately NOT in `config.toml`. Never expose them via config; only override via `DaemonLoopOptions` for tests.
- Capture writes `BUFFER_FULL`; drain clears it. This asymmetry is load-bearing. Do not let drain write `BUFFER_FULL` or let capture clear it.
- `AUTH_FAILED` is first written by `handleAuthError` in the drain cycle's upload path. While it is set, the self-healing auth-recovery loop (`services/polling/auth-recovery.ts`) re-verifies the key on exponential backoff (1s → 2s → 4s …, `AUTH_RECOVERY_MAX_RETRIES = 16` trials ≈ one day), records retry progress into the sentinel via `recordAuthRecoveryState`, and clears it the instant `verify-key` succeeds. The setup reconfigure flow (`setup new` / `dev setup`) also clears it via `clearAuthFailedSentinel`. Those are the only writers/clearers — do not add others.
- The capture, drain, and heartbeat loops all pause (skip the cycle and sleep) while `AUTH_FAILED` is present — they must never `return`/exit on it — and resume automatically once the auth-recovery loop or a reconfigure clears the sentinel. A transient backend outage must never permanently stop the daemon.
- A skipped cycle (sentinel gate fired) must NOT increment `capture_cycles_total` or `drain_cycles_total` — only completed cycles count.
- Capture-cycle source polls run in parallel Bun Worker threads. Workers write to an in-memory `:memory:` SQLite DB; the main thread commits all results in a single ACID transaction. Never let a worker write directly to `buffer.db`.
- A thrown error inside `source.poll(ctx)` propagates uncaught to `captureLoop`, which logs and retries on the next tick. Do not add a top-level try/catch inside `runCaptureCycle` that would swallow such errors silently.
- The drain loop must never gate on `BUFFER_FULL` — drain is precisely the mechanism that relieves that pressure.
- Heartbeat's auto-upgrade calls `exitProcess()` on success (non-brew, non-dev). This is the intended behavior — the service manager respawns the daemon on the new binary. Do not guard against this exit in the heartbeat path.
