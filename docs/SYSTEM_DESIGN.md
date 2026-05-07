# ProxAI Gateway — System Design

The gateway is an on-device daemon that captures local AI-coding-agent activity
(Claude Code, Cursor, Codex), redacts secrets at capture time, buffers the
redacted bytes in a local SQLite database, and ships them to the ProxAI nest
backend. It runs as a managed service under launchd / systemd / Windows Task
Scheduler, polls source files on a configurable interval (default 300 s), and
treats the on-disk source files and the local buffer DB as the two sources of
truth — the server is the source of truth for "delivered." The runtime is
Bun + TypeScript; persistence is SQLite (WAL mode); transport is JSON over HTTP
to two endpoints on `proxai_nest`.

---

## 1. Architecture overview

```
+-------------------+     +-------------------+     +---------------------+
|  Source files     |     |  Source pollers   |     |    Local buffer     |
|                   |     |                   |     |                     |
|  Claude Code      |     |  - discover       |     |  SQLite (WAL)       |
|  ~/.claude/       |     |  - collect        |     |                     |
|  projects/*.jsonl |     |  - redact         |     |  upload_batches     |
|                   | --> |  - zstd compress  | --> |    (pending|failed) |
|  Cursor           |     |  - insertBatch    |     |  source_cursors     |
|  state.vscdb      |     |  - setCursor      |     |  upload_receipts    |
|                   |     |                   |     |  buffer_metadata    |
|  Codex            |     |                   |     |                     |
|  ~/.codex/        |     |                   |     |                     |
+-------------------+     +-------------------+     +----------+----------+
                                                               |
                                                               v
+-------------------+     +-------------------+     +---------------------+
|     Nest API      |     |     Uploader      |     |      Drain         |
|                   |     |                   |     |                     |
|  POST             | <-- |  HttpClient       | <-- |  - nextPendingBatch |
|   /v1/raw_records |     |  - validate DTO   |     |  - pacer.acquire    |
|  GET              |     |  - X-API-Key auth |     |  - upload + persist |
|   /v1/watermarks  |     |  - classify error |     |    receipt          |
|  GET              |     |                   |     |                     |
|   /verify-key     |     |  Pacer            |     |                     |
|                   |     |  - 5/s, 50MiB/min |     |                     |
|                   |     |  - 429 backoff    |     |                     |
+-------------------+     +-------------------+     +---------------------+

           +-----------------+              +--------------------+
           | Service manager |              |     Sentinels      |
           |                 |              |                    |
           |  launchd        |              |  ~/.proxai/PAUSED  |
           |  systemd --user |              |  AUTH_FAILED       |
           |  schtasks       |              |  BUFFER_FULL       |
           +-----------------+              +--------------------+
```

**Sources** are local files written by the AI coding agents themselves. Three
shapes are supported, each handled by a dedicated collector: Claude Code writes
append-only JSONL session transcripts under `~/.claude/projects/`; Cursor
maintains a SQLite KV store at `state.vscdb`; Codex writes both append-only
JSONL rollouts and a SQLite database (`state_*.sqlite`) with several relational
tables. The collectors never write to source files and never proxy traffic.

**Discover and collectors** run inside per-source pollers. Discover walks the
agent's data directory under a glob (or picks the highest-numbered
`state_N.sqlite` for Codex), filters by mtime if no cursor exists yet, and
emits stat-decorated file descriptors. Collect reads only bytes/rows beyond the
local cursor watermark, applies redaction, zstd-compresses the redacted bytes,
and inserts a single batch row.

**Buffer** is a SQLite database at `~/.proxai/buffer.db` (POSIX mode `0600`)
opened in WAL mode with `synchronous = NORMAL`. Four tables hold the entire
state machine: `upload_batches` (pending or failed), `source_cursors`
(per-(app, path-hash, inode, table) watermark and vacuum-detection state),
`upload_receipts` (delivered rows for cross-restart idempotency), and
`buffer_metadata` (last-prune timestamp).

**Redaction** runs once, in-line with the collector, before the bytes are
compressed and inserted. Thirteen ordered categories totalling 100+ regex
rules cover crypto keys, LLM provider keys, source-control credentials, cloud
provider keys, generic high-entropy tokens, communication webhooks, payment
processors, auth providers, CI/package-manager tokens, observability tools,
HTTP headers, DB connection strings, and a final keyword catch-all
(`password=`, `secret=`, etc.). Matches are replaced with `[REDACTED:type]`.
The buffered bytes are the canonical redacted form — upload only base64-encodes
them.

**Drain + uploader + pacer** form the egress path. Each poll cycle, after the
sources finish writing into the buffer, the drain pulls the oldest pending
batch, blocks on the pacer (token-bucket: 5 batches/s and 50 MiB/min by
default, with multiplicative backoff on consecutive 429s), and posts to nest.
On 200 OK the batch is replaced atomically by a receipt row; on retriable
errors the batch stays pending with `attempts` incremented; on a server-side
watermark regression the local cursor is rewound to match the server's view
and the duplicate batch is dropped.

**Service manager** wraps the platform service-unit primitives: `launchctl
print/bootstrap/kickstart/bootout` on macOS, `systemctl --user
{daemon-reload, enable, start, stop, restart}` on Linux, and `schtasks
{/Query, /Create, /Run, /End}` on Windows. The same Bun script (`run` command,
hidden from user-visible help) is the daemon entry point on all platforms.

**Sentinels** are zero-content (or small JSON) files under `~/.proxai/`. Their
presence halts cycles before any source is read: `PAUSED` (manual or
stale-binary), `AUTH_FAILED` (server confirmed the ingestion key is invalid),
`BUFFER_FULL` (pending bytes exceeded the soft-pause threshold; cleared
automatically when pending drops below the resume threshold).

---

## 2. Capture pipeline (data flow)

```
+--------------------------------------------------------------------------+
| One batch's lifecycle, from a source byte to a delivered server record   |
+--------------------------------------------------------------------------+

   1. discover finds source file
      (path, inode, size, mtime; mtime cap on fresh installs only)
                                     |
                                     v
   2. cursor lookup (source_cursors)
      key = (sourceApp, sourcePathHash, sourceInode, watermarkTable)
      yields watermarkEnd (or 0 / inode=0 fallback from server sync)
                                     |
                                     v
   3. read NEW bytes/rows from disk
      jsonl_append:        slice file [watermarkEnd, sizeBytes), trim to last \n
      sqlite_kv_snapshot:  VACUUM INTO temp; SELECT WHERE rowid > N AND key LIKE...
      sqlite_table_snap.:  VACUUM INTO temp; SELECT rowid, * FROM table WHERE ...
                                     |
                                     v
   4. apply single-pass redaction
      13 categories, 100+ regex rules; matches -> [REDACTED:type]
                                     |
                                     v
   5. zstd-compress the redacted bytes (level 3)
                                     |
                                     v
   6. INSERT INTO upload_batches (status='pending', captureId=UUIDv7, body=blob)
                                     |
                                     v
   7. setCursor advances watermark_end
      (NOT in the same SQLite transaction as the INSERT — see audit below)
                                     |
                                     v
                        (... cycle continues for other sources ...)
                                     |
                                     v
   8. drain phase: nextPendingBatch (oldest pending by created_at)
                                     |
                                     v
   9. pacer.acquire(bodyBytes)
      blocks until both buckets allow + any Retry-After / 429 backoff has elapsed
                                     |
                                     v
  10. buildRawRecordDTO + validateRawRecordDTO + base64-encode body
                                     |
                                     v
  11. POST /v1/raw_records, X-API-Key: <ingestionKey>
                                     |
                  +------------------+--------------------+
                  |                  |                    |
                  v                  v                    v
         12a. 200 accepted     12b. 4xx fatal       12c. 429 / 5xx / net
              markBatchDelivered    markBatchFailed     recordRetriableFailure
              (TX: insert receipt   (status='failed';   (attempts++);
               + delete batch)       last_error=...);   pacer.notifyRetryAfter
                                                        + pacer.notify429
                  |                                              |
                  v                                              v
           captureId in receipts;                       same captureId retried
           local cursor stays at                        next cycle (or after
           watermarkEnd                                 pacer wait)

         12d. 400 watermark_regression
              setCursorFromRegression(rewind cursor to currentServerWatermarkEnd);
              deleteBatch (server already had it); next cycle resumes from new cursor

         12e. 401 / 403 (auth)
              reactive verifyKey:
                - verifyKey 5xx/network: recordRetriableFailure (don't halt)
                - verifyKey 401/403:    finalizeAuthFailure: writeAuthFailedSentinel
                                        + markBatchFailed (cycle skipped on next tick)
                - verifyKey ok:         transient — recordRetriableFailure
```

A few transformations along the way are worth naming:

- The compressed body is stored as a `BLOB` in SQLite; it is base64-encoded
  only at upload-time inside `buildRawRecordDTO`. There is no second redaction
  pass on egress — buffer bytes are canonical.
- `captured_at_utc` is the gateway clock at the moment bytes were read off
  disk, not the agent's record timestamp; the server uses agent timestamps from
  the parsed body for its own ordering.
- For Cursor and Codex SQLite sources, the `VACUUM INTO` pattern produces a
  read-only temp file each poll. The temp file's inode is meaningless and
  ephemeral; the wire DTO sets `source_inode = null` for these sources.

---

## 3. Idempotency model

End-to-end exactly-once is layered as three independent gates. Each gate
catches a different failure mode; together they make duplicate delivery safe.

| Layer | Where stored | What it catches |
|---|---|---|
| Local cursor | gateway `source_cursors` (per app, path-hash, inode, table) | Re-reading bytes / rows already captured into the buffer. Advances on `insertBatch`, not on server-accept. |
| `capture_id` UUIDv7 | server `raw_records.capture_id` UNIQUE | Network-retry of an in-flight batch. The server returns `200 { idempotent: true }` on a duplicate — gateway treats both cases identically. |
| Watermark monotonicity | server per-(user, host, path-hash) cursor | Cross-deployment cursor regression. If the gateway ever submits `watermark.start < highest known watermark.end`, the server returns `400 watermark_regression` with its authoritative end; the gateway rewinds the local cursor and drops the duplicate batch. |

Layer 1 is the gateway's own contract with disk: once bytes are buffered, the
cursor advances, and the next cycle reads strictly forward. Layer 2 is a
gateway-server contract: the same `capture_id` may be submitted any number of
times, but the server stores only the first. Layer 3 is a server-enforced
invariant; see `08_BACKEND_CONTRACT.md` §6.3 for the full specification.

The gateway deliberately does **not** wrap `insertBatch` and `setCursor` in a
single SQLite transaction (see `planning/audit_crash_recovery.md`). A crash
between the two writes produces at most one duplicate batch on the next cycle,
which the server's `capture_id` UNIQUE constraint absorbs as
`idempotent: true`. Wrapping in a transaction would close that small window
but would not change the contract; it is documented as an acceptable polish
follow-up.

---

## 4. Stable host_id and reinstall recovery

`host_id = sha256(machine_uuid + ':' + user_id)`, lowercase hex. The machine
UUID comes from `ioreg` on macOS, `/etc/machine-id` (with a fallback to
`/var/lib/dbus/machine-id`) on Linux, and the `MachineGuid` registry value on
Windows. The user id comes from the `verify-key` response — that is, from the
ProxAI account the ingestion key belongs to. Both inputs are trimmed before
hashing.

Because both inputs are stable across binary reinstalls and config wipes, the
host_id is stable too. This is what unlocks reinstall recovery: the server has
already seen this `host_id` and knows the highest watermark it accepted per
file path-hash; the gateway can fetch that view at startup.

```
+-------------------------------------------------------------------+
|              Reinstall on the same machine, same user             |
+-------------------------------------------------------------------+

  1. Operator: rm -rf ~/.proxai
  2. proxai-gateway setup
        |
        v
     verify-key  -> { userId: "u_abc", ... }
        |
        v
     readMachineUuid()  -> "8A3...vendor-uuid"
        |
        v
     deriveHostId(machineUuid, userId)  -> same host_id as before
        |
        v
     write config.toml; register service unit; start daemon

  3. Daemon startup
        |
        v
     openBufferDb()  -> empty cursor table
        |
        v
     countCursors == 0  -> syncServerWatermarks
        |
        v
     GET /v1/watermarks?host_id=<hostId>  ->
        [
          { source_app: "claude-code", source_path_hash: "...", watermark_end: 1024000 },
          { source_app: "cursor",      source_path_hash: "...", watermark_end:  120 },
          ...
        ]
        |
        v
     setCursor for each (sourceApp, pathHash, inode=0 sentinel, table)
        |
        v
  4. First poll cycle
        |
        v
     discover() finds the source files; getCursorWithFallback resolves to
     the inode=0 row and the poller starts at watermark_end seeded from
     server, NOT byte 0 / rowid 0. No duplicate captures.
```

If the user_id changes (e.g. setup with a different account's ingestion key on
the same machine), the host_id rederives and the server-side cursor is a
different (host_id, path_hash) tuple — the new identity starts fresh. The
setup command surfaces this as either `host_id stable`,
`host_id rederived for new user`, or `host_id rederived from machine UUID`.

The watermark sync also runs at the start of `proxai-gateway backfill` when
the cursor table is empty — same logic, same fallback, same failure handling
(a sync error logs but does not abort capture).

---

## 5. Lifecycle (commands + service unit)

The CLI splits cleanly between user-visible lifecycle commands and the hidden
`run` daemon entry point.

| Command | What it does |
|---|---|
| `setup` | Prompts for the ingestion key; verifies it via `GET /ingestion/verify-key`; reads the platform machine UUID; derives the host_id; writes `~/.proxai/config.toml` (mode `0600`); writes the platform service unit (`launchd plist`, `systemd .service`, scheduled-task XML); clears `AUTH_FAILED` if present. Re-running with an existing config requires double-entry of the new key (or `--api-key`). |
| `start` | Ensures the service unit is registered (bootstrap on launchd, daemon-reload + enable on systemd, /Create on schtasks) then starts it. If no config exists, kicks setup interactively first. |
| `stop` | Stops the service via the platform supervisor. Capture pauses; no data loss. |
| `restart` | stop + start. On systemd, uses `restart`; on launchd, `kickstart -k`. |
| `status` | Reads the buffer DB and prints pending/delivered/failed counts, pending bytes, last prune timestamp, paused/buffer-full sentinel state. |
| `tail` | Streams the structured log (newline-delimited JSON) with optional `--since`, `--level`, `--source` filters; `-f` follows file rotation. |
| `redaction list` | Prints the current rule corpus by category, optionally filtered or as JSON. |
| `redaction test <file>` | Runs the redactor against a file and prints the redacted output and per-rule hit counts. |
| `backfill --since Nd` | Runs a single poll cycle with the discovery mtime cap explicitly set to now-N; ingests history older than the default 30-day initial-scan window. |
| `pause` / `resume` | Writes/clears `~/.proxai/PAUSED` (manual halt sentinel). |
| `run` | Hidden. Daemon entrypoint executed by the service unit. |

The daemon's runtime states are best read as a small machine driven by the
sentinels:

```
                    +-----------+
                    |unconfigured|   no ~/.proxai/config.toml
                    +-----+-----+
                          | proxai-gateway setup (writes config + unit)
                          v
                    +-----------+
                    | configured |   not started yet
                    +-----+-----+
                          | proxai-gateway start
                          v
                    +-----------+        SIGTERM / stop
              +---->|  running  +------------------+
              |     +-----+-----+                  |
              |           |                        v
              |           | (cycle observes)+-----------+
              |           |                 |  stopped  |
              |           v                 +-----------+
              |    +------+------+
              |    |   PAUSED    |  manual `pause`, or stale-binary auto-pause
              |    +------+------+
              |           | resume / fresh setup (stale_binary clears via setup)
              |           v
              |    +------+------+
              |    | AUTH_FAILED |  uploader confirmed key invalid
              |    +------+------+
              |           | proxai-gateway setup (with new key)
              |           v
              |    +------+------+
              |    | BUFFER_FULL |  pending bytes > soft-pause threshold
              |    +------+------+
              |           | drain reduces pending below soft-resume threshold
              +-----------+
```

Each sentinel is checked at the head of every poll cycle. `AUTH_FAILED` and
`BUFFER_FULL` short-circuit the cycle entirely; `BUFFER_FULL` is also
self-healing — when pending drops under `bufferSoftResumeBytes`, the sentinel
is removed and capture resumes on the next tick. `PAUSED` is checked after
the stale-binary timer (so an out-of-date binary that crosses
`pauseAfterDays` writes the sentinel itself).

SIGTERM/SIGINT abort propagates only to the inter-cycle sleep — see
`planning/audit_graceful_shutdown.md`. The current cycle (and any in-flight
HTTP request, bounded by the per-request timeout) is allowed to finish; the
loop exits at the next cycle boundary. Shutdown latency is bounded by
cycle-time, not by any in-process watchdog.

---

## 6. Failure modes and recovery

| Failure | Symptom | Gateway behavior | Recovery |
|---|---|---|---|
| Network outage | All uploads fail with `NetworkError`/`RetriableError`; pending grows. | `recordRetriableFailure` increments `attempts`; cycle continues; pacer continues to honor any Retry-After it last absorbed. | Drains automatically when network returns. Captures continue (cursor advances on insert), so source-file mutation doesn't lose data. |
| Server 4xx (validation) | `400 Bad Request` (other than `watermark_regression`), `408`, `413`. | `markBatchFailed`; batch keeps body for diagnostics; not retried. | Pruned after `failedRetentionDays` (default 30). New `capture_id` may help if the bug is fixed and the source range is rebuildable; usually surfaces as a real gateway/contract drift bug. |
| Server 401 / 403 (auth) | First failure: ambiguous (could be transient or real). | Reactive `verifyKey` once per failed upload disambiguates. If verify confirms invalid, `writeAuthFailedSentinel`, `markBatchFailed`. If verify is itself 5xx/network, treat as retriable. If verify still succeeds, the upload's 4xx was transient — retriable. | `proxai-gateway setup` with a fresh ingestion key: setup clears `AUTH_FAILED` after a successful verify, the daemon's next cycle resumes, pending batches retry under the new key. |
| Buffer pressure | `pending_bytes > bufferSoftPauseBytes` (default 700 MB). | Cycle's pressure check writes `BUFFER_FULL` sentinel; subsequent cycles short-circuit until pending drops below `bufferSoftResumeBytes` (default 600 MB). | Self-clearing once drain reduces pending; no source bytes are read while the sentinel is set, so the disk stays bounded. The hard cap protects the user's disk from runaway gateway storage. |
| Source SQLite vacuum | File shrinks, `page_count` drops, or `max(rowid)` regresses below the saved cursor. | `detectVacuum` returns a positive signal; collector rotates `source_path` to `path#gen=N` (and recomputes `path_hash`); next capture starts fresh at watermark 0 under the new identity. | Server treats the new path-hash as a fresh stream; the old cursor row is left in place (frozen). Rotation is logged as `vacuum.detected`. |
| File rotation (inode change) | Same path, new inode (e.g. log rotation, agent rewrites the file). | Cursor key includes inode; the new inode misses the old cursor row. `getCursorWithFallback` then probes the inode=0 fallback (server sync), or starts at 0. The next capture writes a new cursor under the real inode. | Automatic: the next poll picks up the new file from byte 0 (or the server-known watermark, if reinstall sync provided one). |
| Crash mid-cycle | Cycle aborted between `insertBatch` and `setCursor`, or between `markBatchDelivered` and the next cycle. | The pending batch row exists; the cursor lags. On restart, the next cycle re-reads the same range under a new `capture_id`; both batches eventually upload, the server returns `200 { idempotent: true }` on the second. | Bounded duplication (at most one per crash window); no data loss; no aggregation drift on the server. Documented in `planning/audit_crash_recovery.md`. |
| Reinstall | `~/.proxai` wiped; cursors lost. | `setup` rederives the same `host_id`; daemon's pre-flight `syncServerWatermarks` seeds cursors from the server's authoritative state. | Captures resume at the server-known watermark, not byte 0. See §4. |
| Stale binary | Binary's `installedAt` is older than the configured warn/pause days. | `daysSinceInstall >= warnAfterDays` (default 30): warn-level log entry. `daysSinceInstall >= pauseAfterDays` (default 60): writes `PAUSED` sentinel with reason `stale_binary: ...`. | `proxai-gateway setup` with the new binary refreshes `installedAt` and clears the pause; alternatively, the operator can `resume` to reset the sentinel manually (the next cycle will re-write it if the binary is still too old). |

Several of the recovery paths are deliberately gateway-side, not
contract-side: the server has no notion of vacuum or inode rotation, so the
gateway picks `path#gen=N` as the rekeying convention (see
`08_BACKEND_CONTRACT.md` §6.3).

---

## 7. Lifecycle of a captured byte

A trace through the system, following a single byte from when the user types
it to when the redacted record is queryable in nest. The annotation is the
component that produced the transition.

```
t=0          User types a character in Claude Code.
             Claude Code's process appends a partial JSON line to
             ~/.claude/projects/<proj>/<session-uuid>.jsonl
             (writer flushes at end-of-line; partial line may sit briefly).

t=t_flush    Writer emits the trailing '\n'. Line is now complete on disk.

t<=300s      Daemon's poll cycle begins. (default poll_interval_sec=300)
             [poll-loop] runPollCycle starts.
             [poll-cycle] sentinel checks pass.

             [poll-claude-code] discoverClaudeCodeFiles enumerates
             ~/.claude/projects/*/*.jsonl; this file's mtime is fresh.

             [poll-claude-code] makeClaudeCodeSourcePoller iterates;
             [collect.ts] collectClaudeCodeFile resolves the cursor
             (getCursorWithFallback).

             [collect.ts] Reads bytes [watermarkEnd, fileSizeBytes) via
             readJsonlRange — which trims to the last '\n' so partial lines
             are held over. Our byte is now in `range.bytes`.

             [redaction.ts] applyRedaction iterates 13 rule categories;
             our byte was just regular text, not a secret, so it survives
             unmodified. The redactor returns `{ redacted, matchCount, ruleHits }`.

             [compress.ts] zstdCompressSync compresses the redacted UTF-8.

             [batches.ts] insertBatch writes a new upload_batches row with
             status='pending', captureId=UUIDv7, body=<compressed bytes>.

             [cursors.ts] setCursor advances watermark_end to the end of
             the read range. Two adjacent statements; not transactional.

t<=300s+eps  [drain-buffer.ts] drainBuffer runs after all sources finish.
             [pacer.ts] pacer.acquire(bodyBytes) blocks until both buckets
             admit. (Typical idle gateway sees no contention.)

             [build-dto.ts] buildRawRecordDTO + base64-encode the body.
             [validate.ts]  validateRawRecordDTO sanity-checks the DTO.

             [client.ts] HttpClient.uploadRawRecord:
               POST <ingestUrl>
               X-API-Key: <ingestionKey>
               Content-Type: application/json
               body: { capture_id, host_id, source_*, watermark, agent_schema_version,
                       gateway_version, captured_at_utc, body_format, body_compression,
                       body: "<base64 zstd>" }

t<=300s+rt   Nest receives, validates DTO, decompresses body within 5s,
             runs server-side redaction (defense in depth), PUTs to S3,
             indexes in Postgres, enqueues parser job, returns
             { capture_id, accepted: true, idempotent: false }.

             [upload-batch.ts] markBatchDelivered runs in a single SQLite
             transaction:
               INSERT INTO upload_receipts ...
               DELETE FROM upload_batches WHERE capture_id = ?

t=t+parse    Parser job processes the JSONL line off S3, materializes the
             record into nest's Postgres tables; the user can now see the
             record in the dashboard.

             Local state at this point:
               - upload_batches:    no row for this capture_id
               - upload_receipts:   one row with delivered_at
               - source_cursors:    watermark_end advanced
               - the JSONL file:    untouched
```

The whole pipeline is single-pass and zero-copy from the user's perspective —
no proxy, no traffic interception, no second-pass redaction at upload, and
no requirement that the agent runs while the gateway is offline (cursor
state survives restart; bytes are still on disk).

---

## 8. Configuration reference

`~/.proxai/config.toml` is the single source of runtime configuration. It is
written by `proxai-gateway setup` (POSIX mode `0600`) and reloaded on daemon
start. The full schema — every field, default, range, and semantic — is
catalogued in [`CONFIG_REFERENCE.md`](./CONFIG_REFERENCE.md).

In short: `[account]` carries the ingestion key, derived host_id, and install
metadata. `[backend]` is normally absent (defaults to the production nest URLs;
override via `PROXAI_NEST_URL` env var or explicit fields). `[capture]` holds
the operational knobs (poll interval, buffer thresholds, retention windows,
upload pacing). `[logging]` selects the level and the log directory.
`[stale_binary]` parameterizes the freshness checks.

---

## 9. Operator runbook

Common diagnostic-and-remediation flows are catalogued in
[`OPERATOR_RUNBOOK.md`](./OPERATOR_RUNBOOK.md). Highlights: how to read
`proxai-gateway status`, how to disambiguate "no captures" causes, how to
react to `AUTH_FAILED` and `BUFFER_FULL`, how to validate the redaction
corpus against a sample file, and how to use `backfill` to ingest history
older than the default 30-day initial-scan window.

---

## 10. Where to read next

- [`08_BACKEND_CONTRACT.md`](../08_BACKEND_CONTRACT.md) — the wire
  contract with `proxai_nest`. Required reading before changing anything that
  touches the DTO, the watermark, or idempotency.
- [`planning/audit_crash_recovery.md`](../planning/audit_crash_recovery.md) —
  the design rationale for advancing the cursor on `insertBatch` rather than
  on server-accept, and the bounded-duplicate semantics on crash.
- [`planning/audit_graceful_shutdown.md`](../planning/audit_graceful_shutdown.md)
  — why the abort signal stops at the cycle boundary and not at in-flight
  uploads.
- [`planning/03_FLUSHING_ALGORITHM.md`](../planning/03_FLUSHING_ALGORITHM.md),
  [`planning/ALGORITHM_CLAUDE.md`](../planning/ALGORITHM_CLAUDE.md),
  [`planning/ALGORITHM_CURSOR.md`](../planning/ALGORITHM_CURSOR.md),
  [`planning/ALGORITHM_CODEX.md`](../planning/ALGORITHM_CODEX.md) — per-source
  algorithm specs.
- [`README.md`](../README.md) — end-user installation and CLI reference.
- [`CONFIG_REFERENCE.md`](./CONFIG_REFERENCE.md) and
  [`OPERATOR_RUNBOOK.md`](./OPERATOR_RUNBOOK.md) — companion docs to this one.
