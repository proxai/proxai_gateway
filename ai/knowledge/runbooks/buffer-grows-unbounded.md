# Runbook: Buffer Grows Unbounded

Symptom: `buffer.db` on disk grows past `buffer_soft_pause_bytes`
(50 GiB default). `BUFFER_FULL` sentinel is being written and cleared
in a loop, or stays set. Disk-space pressure on the host.

Pending pressure is `SUM(LENGTH(body))` over `status = 'pending'` rows
only — failed, receipts, and quarantined do not count toward soft-pause.
The `pruneBuffer` policy only touches receipts, failed batches, and
quarantined. **Pending rows are never time-pruned** — they only go away
via shipment or `dropOldestPending`.

## Phase 1: identify the growth source

### 1. Confirm the growth is pending, not receipts

```
proxai-gateway status
```

Look at:
- `pending_bytes` (the soft-pause measurement)
- `failed_batches` count
- `receipts` count (informational; capped by `receipt_retention_days`)

If `pending_bytes` is large but `failed_batches` is also large, see
Phase 2. If `pending_bytes` is large and failed is small, the
uploader is just behind — Phase 3.

### 2. Check sentinel state

```
ls -la ~/.proxai/proxai-gateway/BUFFER_FULL
ls -la ~/.proxai/proxai-gateway/AUTH_FAILED
ls -la ~/.proxai/proxai-gateway/SESSION_STOPPED
```

If `AUTH_FAILED` is set, drain isn't running — re-run `setup --force`
to clear it. If `SESSION_STOPPED` is set the daemon process is stopped
for this boot; run `proxai-gateway start` or reboot.

If only `BUFFER_FULL` is set and capture is gated but drain is running
(check `drain_cycles_total` advancing), this is the recovery flow
working as designed. The drain will eventually clear
`BUFFER_FULL` once `pending_bytes < buffer_soft_resume_bytes`
(`drain-cycle.ts:101-125`).

## Phase 2: stuck failed batches

Failed batches sit in `buffer.db` for `failed_retention_days` (30 by
default). They are bounded but visible.

A failed batch indicates `markBatchFailed` was called (drain treats
`ValidationError`, `GatewayError`, and unknown errors as fatal). The
batch is no longer in the pending pool; it will not be retried.

Query (via inspect-style adhoc, since direct sqlite access is
discouraged):
```
proxai-gateway tail --since 7d --raw | grep upload.fatal | wc -l
```

If the count of `upload.fatal` events roughly matches the failed
count, the cause was a consistent failure mode in some source —
check the `kind` and `source_app` fields. The fix is in the source
parser, not the buffer.

`prune` will eventually remove these after `failed_retention_days`.
If disk space is urgent, lower the retention temporarily in
`config.toml` and wait for the next drain cycle (each drain
cycle calls `pruneBuffer`).

## Phase 3: drain is too slow

Pending grows because the uploader cannot keep up with the capture
rate. Check:

### 1. Pacer backoff

```
proxai-gateway tail --since 1h --raw | grep -E 'rate_limited|retriable'
```

If the pacer is being throttled by 429s or 5xx backoff, the upload
rate is capped by the server. The three pacer signals
(`ai/rules/services/backend-protocol.md`):
- `Retry-After` header
- 429 exponential (capped 30 s)
- 5xx exponential (capped 5 min)

Stack in acquisition order. Both counters cap at 16 steps.

If the daemon is backed off and the server is healthy from other
hosts' POV, the server is intentionally rate-limiting this host —
contact backend ops with the host_id.

### 2. Network throughput

Look at `drain.complete` event `accepted` and `accepted_bytes` over a
window. Bytes-per-second of drain capacity is `accepted_bytes /
window_seconds`. If that's substantially below the host's egress
bandwidth, look at upstream MTU / proxy / SSL inspection overhead.

### 3. Capture rate

`source.poll.complete` events show `captured_bytes` per source per
cycle. If capture is producing far more than drain can ship, the only
sustainable fix is to raise `upload_max_bytes_per_minute` in
`config.toml`. The buffer is doing its job (preserving data) but
cannot grow forever.

## Phase 4: vacuum-detect storm

If a sqlite-backed source repeatedly triggers `vacuum.detected`, the
cursor resets to `watermark_end = 0` each time and re-captures the
full source DB. This produces a flood of pending batches.

Search:
```
proxai-gateway tail --since 24h --raw | grep vacuum.detected
```

If the same `source_path` appears multiple times per day,
`detectVacuum` is firing on a source the user is genuinely VACUUM-ing
that often (probably a misconfigured client). The
`detectVacuum` triggers on `size_decreased`, `page_count_decreased`,
or `rowid_regressed` (`buffer/vacuum-detect.ts`). A source that
shrinks regularly will produce this storm.

Mitigation: there is no per-source vacuum-rate-limit currently.
Either contact the agent's maintainers about the VACUUM frequency or
add a per-source `vacuum_cooldown` to the source's options.

## Phase 5: emergency relief

If the disk is dangerously full and the user needs space *now*:

1. `proxai-gateway stop` — halts the daemon process for this boot so
   capture stops. Drain stops too, but the buffer no longer grows.
2. If you also need drain to keep running, start the daemon again and
   wait — drain ships as much as it can each 30 s cycle.
3. If still full, the only safe knob is dropping the oldest pending
   batches via `dropOldestPending` (one-shot SQL). This is data loss
   for those batches.
4. Lower `buffer_soft_pause_bytes` temporarily so the daemon stops
   accepting new captures until pressure relieves.

The gateway intentionally has no "drop pending on overflow" auto-
policy — losing data silently was judged worse than running out of
disk.

[source: src/services/buffer/pressure.ts, src/services/buffer/prune.ts, src/services/buffer/batches.ts, src/services/polling/drain-cycle.ts, src/services/uploader/drain-buffer.ts, ai/knowledge/runbooks/daemon-not-uploading.md]
