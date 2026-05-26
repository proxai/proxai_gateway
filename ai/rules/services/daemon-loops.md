# Daemon Loop Rules

- The three loops (capture, drain, heartbeat) run under `Promise.all` in `runDaemonLoops`. They never coordinate in memory — only through SQLite rows and sentinel files.
- Loop intervals (`CAPTURE_INTERVAL_MS = 120_000`, `DRAIN_INTERVAL_MS = 30_000`, `HEARTBEAT_INTERVAL_MS = 3_600_000`) are constants in `polling.constants.ts` and are deliberately NOT in `config.toml`. Never expose them via config; only override via `DaemonLoopOptions` for tests.
- Capture writes `BUFFER_FULL`; drain clears it. This asymmetry is load-bearing. Do not let drain write `BUFFER_FULL` or let capture clear it.
- `AUTH_FAILED` is written only by `handleAuthError` in the drain cycle's upload path; it is cleared only by `setup --force`. Do not add other writers or clearers.
- `PAUSED` is written by the `pause` command and by heartbeat's `checkStaleBinary`; it is cleared only by the `resume` command. The daemon never clears `PAUSED` on its own.
- A skipped cycle (sentinel gate fired) must NOT increment `capture_cycles_total` or `drain_cycles_total` — only completed cycles count.
- Capture-cycle source polls run in parallel Bun Worker threads. Workers write to an in-memory `:memory:` SQLite DB; the main thread commits all results in a single ACID transaction. Never let a worker write directly to `buffer.db`.
- A thrown error inside `source.poll(ctx)` propagates uncaught to `captureLoop`, which logs and retries on the next tick. Do not add a top-level try/catch inside `runCaptureCycle` that would swallow such errors silently.
- The drain loop must never gate on `BUFFER_FULL` — drain is precisely the mechanism that relieves that pressure.
- Heartbeat's auto-upgrade calls `exitProcess()` on success (non-brew, non-dev). This is the intended behavior — the service manager respawns the daemon on the new binary. Do not guard against this exit in the heartbeat path.
