# polling

`src/services/polling/` owns the daemon's three concurrent loops plus the four gate-sentinels (auth-failed, buffer-full, session-stopped, update-available). Capture/drain/heartbeat run under one `Promise.all` and coordinate only via sentinel files and `buffer.db` rows.

## Loops

| Loop | Interval (constant) | Default | Skip sentinels (in order) | Per-cycle effects |
| --- | --- | --- | --- | --- |
| Capture | `CAPTURE_INTERVAL_MS` | `120_000` (2 min) | `AUTH_FAILED` → `BUFFER_FULL` (first hit short-circuits) | Spawn one worker per source; commit batches/quarantine/cursors in one tx; write `BUFFER_FULL` if pressure exceeds `softPauseBytes`; persist `capture_cycles_total` + `daemon_state.lastSourceCaptures`. |
| Drain | `DRAIN_INTERVAL_MS` | `30_000` (30 s) | `AUTH_FAILED` only (intentionally NOT `BUFFER_FULL` — drain is what relieves it) | `drainBuffer` walks pending batches via cursor pagination; runs `pruneBuffer`; if pressure < `softResumeBytes`, clear `BUFFER_FULL`; persist `daemon_state` + drain metrics. |
| Heartbeat | `HEARTBEAT_INTERVAL_MS` | `3_600_000` (1 h) | none (version checks must run even when auth is broken) | `checkStaleBinary` logs a warning past `pauseAfterDays`; throttled version check (default 4 h between checks via `metadata.last_version_check_at`); brew → `UPDATE_AVAILABLE` sentinel, others → `runAutoUpgrade` (in-place replace + `exitProcess`). |

Intervals are constants in `polling.constants.ts` and deliberately **not** in `config.toml`. Override only via `DaemonLoopOptions.{captureIntervalMs,drainIntervalMs,heartbeatIntervalMs}` in tests.

## `runDaemonLoops`

```ts
await Promise.all([
  captureLoop(ctx.capture, captureMs, signal, sleep, onCaptureComplete),
  drainLoop(ctx.drain, drainMs, signal, sleep, onDrainComplete),
  heartbeatLoop(ctx.heartbeat, heartbeatMs, signal, sleep, onHeartbeatComplete),
]);
```

Each loop is a `while (!isAborted) { try runCycle catch log; sleep(intervalMs, signal); }`. A thrown error from `runCaptureCycle` / `runDrainCycle` is **caught and logged** by the loop wrapper (`capture.cycle.error`, `drain.cycle.error`) — the loop retries on the next tick. `runHeartbeatCycle` does NOT have a top-level try/catch in the loop because its internal `try` already swallows version-check failures.

Sleep is abortable: `options.sleep ?? abortableSleep` from `core/utils`. The `AbortSignal` short-circuits both the sleep and the next-iteration guard.

`notify(cb, result, logger, errorEvent)` wraps callback invocation in try/catch and logs `*.cycle.callback_failed` if a callback throws — a bad callback never breaks the loop.

## Capture cycle internals (`capture-cycle.ts`)

1. Sentinel gate check (auth → buffer-full); first hit returns a `CaptureCycleResult` with the relevant flag set and `sourceResults: {}`, `pressureResult: null`. Skipped cycles do not bump `capture_cycles_total`.
2. For each registered source: `pollSourceInWorker(source, ctx)` if the source is in `['claude-code', 'cursor', 'gemini-cli', 'codex']`, else `source.poll(sourceCtx)` directly.
3. Worker dispatch dual-mode: when running under `bun build --compile`, `import.meta.url` includes `$bunfs` or `bun:wrap` — in that case the worker runs in-process (`handleCapture` called directly) because `new Worker(new URL('./poll-worker.ts', import.meta.url))` cannot resolve a relative module from inside the compiled binary. Both branches commit results identically.
4. Each worker returns `{ batches[], quarantine[], cursors[] }`. The main thread wraps `insertBatch` + `recordQuarantine` + `setCursor` calls in a single `ctx.buffer.transaction(() => …)` per source — ACID guarantee against partial cursor advance.
5. `applyPressureSentinel(ctx, log)` runs after all sources; on `shouldPause` it writes `BUFFER_FULL` with `{ pendingBytes, threshold, setAt }`.
6. `persistCaptureMetrics` increments `capture_cycles_total`, sets `capture_last_cycle_at` + `capture_last_cycle_duration_ms`; if any source had errors, increments `capture_cycles_with_errors`.
7. `persistSourceCaptures` merges per-source counters into `daemon_state.lastSourceCaptures`.

## Drain cycle internals (`drain-cycle.ts`)

1. Sentinel gate check (auth only). Skipped cycles do not bump `drain_cycles_total`.
2. `drainBuffer(uploaderCtx)` (see `uploader.md`) returns `DrainResult`. Log `drain.complete`.
3. `pruneBuffer({ db, receiptRetentionDays, failedRetentionDays })` — swallows errors and logs `buffer.prune_failed`.
4. `applyResumeSentinel`: if `shouldResume` AND `BUFFER_FULL` exists, `clearBufferFullSentinel` and log `buffer.soft_resume`.
5. `persistDaemonState` writes the singleton `daemon_state` row with drain counters + start/complete/duration.
6. `persistDrainMetrics` increments `drain_cycles_total`, `drain_total_batches_shipped`, `drain_total_bytes_shipped`, plus legacy `upload_total_*` mirrors, plus per-source `upload_batches_shipped_by_source.<app>` keys.

## Heartbeat cycle internals (`heartbeat-cycle.ts`)

1. Sentinel gate: none — heartbeat always runs so auto-upgrade and version checks can recover the daemon.
2. `checkStaleBinary(deps)`: parse `installedAt`; if `daysSinceInstall >= pauseAfterDays`, log `stale_binary.stale` (auto-upgrade replaces the binary on the next heartbeat). Otherwise if `>= warnAfterDays`, log `stale_binary.warning`. `installedAt` parse failure logs and returns `fresh` (fail-open).
3. `shouldRunAutoUpgrade(ctx)`: brew → must have `updateAvailableSentinelPath`; others → must have `binaryPath` AND `currentVersion`.
4. `maybeRunAutoUpgrade`: throttle via `metadata.last_version_check_at` vs `DEFAULT_VERSION_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000` (configurable via `versionCheckIntervalMs`).
5. Brew branch: `runBrewSentinelCheck` calls `checkLatestVersion`, writes `UPDATE_AVAILABLE` sentinel on `hasUpdate`, clears it otherwise. Brew never replaces the binary in-place — Homebrew owns the path.
6. Non-brew branch: `runAutoUpgrade(autoDeps)` — see `upgrade.md`. On success, `exitProcess()` is called; the service manager respawns.

## Sentinel reader/writer modules

| File | Purpose | Writers | Readers (gate) |
| --- | --- | --- | --- |
| `auth-failed-sentinel.ts` | JSON payload `{ reason, detected_at }`. | `handleAuthError` in uploader (only); cleared by `setup new` / `dev setup`. | Capture (gate 1) + drain (gate 1). |
| `buffer-full-sentinel.ts` | JSON `{ pending_bytes, threshold, set_at }`. | Capture cycle's `applyPressureSentinel`. Cleared by drain's `applyResumeSentinel`. | Capture (gate 3) only. |
| `session-stopped-sentinel.ts` | JSON `{ boot_id, set_at }`. Self-clearing read (`isCurrentSessionStopped` clears on boot_id mismatch). | CLI `service stop`. Cleared on next boot via the mismatch path, or by any start-triggering action (`start`, `setup`, auto-upgrade respawn). | Not gated; informational for `status`. |
| `update-available-sentinel.ts` | JSON `{ latest_version, current_version, detected_at, asset_url? }`. | Heartbeat's `runBrewSentinelCheck`. | Brew users only; `status` reads it. |

All writes go through `sentinelHandle(path).write(payload)` which uses `writeAtomic` (temp + rename). Reads are `sentinelHandle(path).read()` returning empty string for missing/empty files. Gate existence checks are pure `Bun.file(path).exists()` — no body parse on the hot path.

## Source registry

`buildDefaultSources(options)` returns four `RegisteredSource` entries (claude-code, cursor, codex, gemini-cli), each with `{ name, poll: makeXxxSourcePoller(opts), baseDir? }`. Each poller wraps the source's `discover` + `collect` per-file. The capture cycle's worker-dispatch shortcut bypasses these in-process pollers when running default sources — the worker calls `handleCapture` directly.

## `runPollCycle` (one-shot)

`poll-cycle.ts` is the synchronous "capture then drain once" used by the `poll` CLI command and tests. It runs `runCaptureCycle` then `runDrainCycle` sequentially; if capture returns auth-failed/buffer-full it skips drain.

[source: src/services/polling/daemon-loops.ts:26-118; src/services/polling/polling.constants.ts:3-14; src/services/polling/capture-cycle.ts:32-525; src/services/polling/drain-cycle.ts:22-253; src/services/polling/heartbeat-cycle.ts:19-155; src/services/polling/stale-binary.ts:17-58; src/services/polling/default-sources.ts:20-49; src/services/polling/poll-cycle.ts:10-67; src/services/polling/{auth-failed,buffer-full,session-stopped,update-available}-sentinel.ts]
