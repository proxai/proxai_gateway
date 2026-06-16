# Runbook: Daemon Not Uploading

Symptom: `status` shows pending batches in the buffer, capture cycles are
ticking, but `drain` isn't moving the numbers. `buffer_pending_bytes`
grows over time.

This is distinct from `debug-stuck-daemon.md` (which covers sentinel-
gated states). Here the cycles are running but the upload path itself
is failing without writing a sentinel.

## Diagnostic order

### 1. Confirm capture vs drain ratio

```
proxai-gateway status
```

Look at:
- `capture_cycles_total` advancing
- `drain_cycles_total` advancing
- `upload_total_batches_shipped` is **NOT** advancing
- pending batch count rising

If `drain_cycles_total` is also not advancing → it's a sentinel issue,
go to `debug-stuck-daemon.md`. Drain is silently gated.

### 2. Tail for drain events

```
proxai-gateway tail --level warn --since 2h
```

The four event signatures to look for, in priority order:

- `auth.invalid` (FATAL) — `handleAuthError` finalized auth failure;
  `AUTH_FAILED` sentinel written. Drain will keep skipping.
  → `setup new` with valid key.
- `upload.rate_limited` (ERROR) with `retry_after_ms` — server told the
  daemon to back off. Look at the value; if `retry_after_ms > 300_000`
  (5 min), the server is intentionally throttling this host. Check
  proxai_nest rate-limit config.
- `upload.retriable` with `kind: NetworkError` — DNS / TCP failure.
  Check `http_url` field; verify endpoint is reachable from the host.
- `upload.fatal` with `kind: ValidationError` — DTO was rejected by
  `validateRawRecordDTO` *or* the server. Re-run `proxai-gateway
  inspect` to see if the same record fails the on-device validator. If
  so, the parser produced a malformed record — bug in the source's
  `collect.ts`.
- `upload.fatal` with `kind: OversizedDecompressedSliceError` —
  a single row > 10 MiB. Check `quarantined_records` count via
  `status`. The cursor advanced past it; future cycles won't retry.

### 3. Look for `drain.cycle.skipped`

Tail with the cycle event:

```
proxai-gateway tail --since 30m --raw | grep drain.cycle
```

Output patterns:
- `drain.cycle.skipped` with `reason: auth_failed` or `paused` →
  sentinel issue; go to debug-stuck-daemon.md.
- `drain.cycle.complete` with `attempted > 0, accepted = 0, retriable >
  0` → see step 4.
- `drain.cycle.complete` with `attempted = 0` → buffer is empty but
  `status` says it isn't. This means `nextPendingBatch` is returning
  null while pending rows exist. Check if rows have status = 'failed'
  (a previous `markBatchFailed` flipped them out of 'pending'). Fix:
  inspect `upload_batches` directly to count `status` values.

### 4. Consecutive retriable break

If `drain.complete` shows three retriables in a row, the drain loop
breaks out for that cycle. From `upload-batch.ts`, the
`consecutiveRetriableBreak` flag is set on `DrainResult` and persisted
in `daemon_state.lastConsecutiveRetriableBreak`. The next drain tick
(30 s) will try again from scratch.

If the break is sticking, the underlying transient is not
self-healing. Network DNS issue: restart the daemon to re-resolve.
Server 5xx: wait for it to recover.

### 5. The auth handshake edge case

`handleAuthError` (`upload-batch.ts:157-210`) has a non-obvious branch:
when upload returns 401/403, the daemon calls `verifyKey()`. If
`verifyKey` itself returns a non-auth error (e.g. network failure),
the original auth error becomes `retriable` with `reason:
auth_unconfirmed` — **not** fatal. `AUTH_FAILED` is NOT written. This
means a daemon can sit in a `auth_unconfirmed` retriable loop
indefinitely if `verifyKey` keeps failing for transient reasons.

Signature in tail: `upload.auth_unconfirmed` events repeating with
varying `kind` values (NetworkError, RetriableError). Recovery:
restart the daemon or wait for the underlying transient to resolve.

### 6. Buffer pressure side-effect

If pending bytes exceed `buffer_soft_pause_bytes` (50 GiB default,
configurable via `config.toml`), `BUFFER_FULL` sentinel is written by
capture and capture cycles start skipping. Drain still runs (drain
never gates on `BUFFER_FULL`) and clears the sentinel when pressure
drops below `buffer_soft_resume_bytes` (45 GiB).

If drain is too slow for the capture rate, this pattern oscillates.
Look for repeated `buffer.soft_pause` / `buffer.soft_resume` events.
Mitigation: increase `upload_max_bytes_per_minute` in `config.toml`.

### 7. Repeated Daemon Crashes and Watchdog Restarts

If the daemon crashes repeatedly but is immediately restarted by the native OS supervisor or the periodic watchdog, it may continue to capture data and write it to the buffer database, while never staying up long enough to upload batches.
- Inspect the watchdog ledger (`RESCUE_LEDGER` in the config directory) to see the history of rescue attempts.
- Compare timestamps in the ledger's `attempts` array or system supervisor logs (like `journalctl` or `log show`) to see if the process is cycling.
- If the daemon crashes repeatedly, follow the troubleshooting steps in `debug-stuck-daemon.md` to identify startup or loop crash causes.

[source: src/services/uploader/upload-batch.ts, src/services/uploader/drain-buffer.ts, src/services/polling/drain-cycle.ts, src/services/buffer/pressure.ts, src/services/rescue/rescue-ledger.ts, ai/knowledge/runbooks/debug-stuck-daemon.md]
