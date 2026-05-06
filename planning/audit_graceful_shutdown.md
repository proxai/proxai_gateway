# Audit: Graceful Shutdown Signal Propagation

Audit-only. Findings and recommendation only; any code change would be a
separate commit.

## 1. Signal Handlers

SIGINT and SIGTERM are wired in `src/main.ts`:

- The `run` command (the daemon) at L200–202:
  ```
  const ctrl = new AbortController();
  process.on('SIGINT',  () => ctrl.abort());
  process.on('SIGTERM', () => ctrl.abort());
  ```
- The `tail -f` command at L297–299 uses an identical pattern for streaming.

Both handlers do nothing more than call `ctrl.abort()`. They do not call
`process.exit`, so the program shuts down via the normal `await` chain unwinding
back to the top-level `program.parseAsync()` and `process.exit(result.exitCode)`
on completion.

## 2. Abort-Signal Flow

```
main.ts (SIGINT/SIGTERM)
  └─ ctrl.abort()
       └─ ctrl.signal      ───▶  runDaemon({ abortSignal })          [run.ts L19, L105]
                                    └─ runPollLoop(cycleCtx, { abortSignal })   [poll-loop.ts L9]
                                          ├─ checks signal.aborted BETWEEN cycles  [L17, L20]
                                          └─ sleepUntilAbort(intervalMs, signal)   [L37–53]
                                               └─ cancels the sleep timer when aborted
```

Critical observation: **the abort signal is consumed only by the loop driver
and the inter-cycle sleep**. It is *not* threaded into:

- `runPollCycle` (`src/services/polling/poll-cycle.ts`) — runs source pollers
  and `drainBuffer` to completion.
- Source pollers (`collectClaudeCodeFile`, `collectCursorFile`,
  `collectCodexRollout`, `collectCodexState`).
- `drainBuffer` (`src/services/uploader/drain-buffer.ts`) — its `while`
  loop does not check the abort signal.
- `uploadBatch` (`src/services/uploader/upload-batch.ts`).
- `HttpClient.request` (`src/services/http/client.ts` L132–138). The fetch
  call uses *only* `AbortSignal.timeout(this.timeoutMs)`. The daemon's
  shutdown signal is never spliced into this AbortSignal.

## 3. Mid-cycle Behavior

When SIGTERM/SIGINT arrives while a cycle is running:

1. The handler fires `ctrl.abort()`.
2. The current `runPollCycle` continues to completion: every source poller
   finishes its read+insert+setCursor sequence, then `drainBuffer` runs.
3. `drainBuffer` continues until either the pending queue is exhausted, the
   per-cycle cap is reached (`DEFAULT_MAX_BATCHES_PER_DRAIN`), or it hits a
   retriable failure (rate-limit) and returns. It does not poll the abort
   signal.
4. Inside `drainBuffer`, each `uploadBatch` call awaits
   `ctx.http.uploadRawRecord(dto)`. The fetch call has its own
   `timeoutMs`-based AbortSignal — independent of the daemon's signal. The
   in-flight HTTP request *cannot* be cancelled by SIGTERM.
5. Once `runPollCycle` returns, control flows back into `runPollLoop`. The
   loop checks `signal.aborted`, sees `true`, and returns without sleeping.
6. `runDaemon`'s `finally` block runs: logs `daemon.stop` and closes the
   buffer DB.
7. The promise chain unwinds; the `run` action returns; `process.exit(0)` is
   reached.

So the *actual* end-to-end behavior is:

- Cycles always run to completion (source poll + buffer drain).
- In-flight HTTP uploads complete (or hit their own timeout).
- After the active cycle finishes, the loop exits without sleeping.

This is the desired contract: SIGTERM means "stop after the current cycle",
not "interrupt now."

## 4. Findings

### 4.1 No mid-flight interruption (good)

The abort signal does not cross the cycle boundary. There is no path by which
a SIGTERM can cancel an in-flight upload, source read, or batch insert. This
is correct.

### 4.2 No long-tail risk from AbortSignal.timeout (good)

`HttpClient.request` uses `AbortSignal.timeout(this.timeoutMs)` (default
`DEFAULT_TIMEOUT_MS` from `src/services/http/http.constants.ts`). Each request
has a bounded ceiling, so SIGTERM cannot be blocked indefinitely by a stuck
fetch.

### 4.3 No watchdog escalation (consider)

If a poll cycle is exceptionally long (e.g. many large batches in
`drainBuffer` running serially, each up to `timeoutMs`), the time between
SIGTERM and process exit could be `cycle-time` rather than "fast". Today's
service supervisors (launchd / systemd / Windows Scheduler) will issue
SIGKILL after their own grace period if the daemon hasn't exited. There is no
in-process watchdog that escalates `ctrl.abort()` to a hard cancel after a
deadline.

This is *not* a bug — the current behavior is correct ("complete the cycle").
But operators should know that "shutdown latency" is bounded by `cycle-time`,
not by a configurable shutdown deadline.

### 4.4 No bugs found

The audit goal — "verify SIGTERM/SIGINT during a poll cycle let the cycle
finish cleanly without interrupting mid-upload" — is satisfied by the current
code. The deliberate decision *not* to propagate the signal into
`HttpClient.request` is exactly what produces this property.

## 5. Recommendation

**No code change needed.** The graceful-shutdown contract is satisfied.

Optional polish (not required):

1. Add an explicit comment in `src/services/http/client.ts` next to the
   `AbortSignal.timeout(this.timeoutMs)` line stating: "The daemon's shutdown
   AbortSignal is intentionally not threaded here. Shutdown waits for the
   current cycle (and any in-flight uploads) to complete." This documents the
   non-obvious invariant for future maintainers who might be tempted to
   `AbortSignal.any([timeout, daemon])`.
2. Optionally add a debug-level "shutdown requested" log line on the first
   cycle-boundary observation of `signal.aborted === true`, so operators can
   correlate SIGTERM-receipt to actual loop exit in the structured log.

If a hard-deadline shutdown were ever required (e.g. supervisor SLA forces
exit within N seconds), the right place to add it would be a
`Promise.race([cycle, deadline])` in `runPollLoop`, *not* in `HttpClient`.
That keeps the cycle's bytes-already-on-the-wire to itself and lets the
daemon abandon the cycle as a whole — a clean "cycle was interrupted, retry
on next start" semantic that the buffer + receipts already handle.
