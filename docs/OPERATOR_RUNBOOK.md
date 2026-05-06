# Operator runbook

Practical diagnostic and remediation flows. Each entry begins with the symptom
the operator observes, walks through the diagnosis steps, then describes the
remediation. Cross-references to system design sections use the form
"see SYSTEM_DESIGN.md §N".

## Daemon doesn't seem to be capturing

**Symptom.** No new receipts in `proxai-gateway status`; pending count is
stable; recent activity is missing from the dashboard.

**Diagnosis.**

1. `proxai-gateway status`. The output reports `status: PAUSED` or
   `buffer_full: yes` if a sentinel is halting the cycle. If `status: active`
   and `buffer_full: no`, look at counts: a non-zero `pending` with stable
   `delivered` indicates upload failure, not capture failure.
2. Check the service unit is registered and running for the platform:
   - macOS: `launchctl print gui/$(id -u)/co.proxai.gateway`
   - Linux: `systemctl --user status proxai-gateway.service`
   - Windows: `schtasks /Query /TN "ProxAI Gateway" /FO LIST`
3. `proxai-gateway tail --level warn --since 1h`. Recent warn/error entries
   from `cycle.*`, `source.poll.*`, `upload.*`, `auth.*` give the proximate
   cause.
4. If only one source app is silent, confirm the source files actually exist:
   `~/.claude/projects/<proj>/<session>.jsonl`, Cursor's `state.vscdb`, or
   `~/.codex/state_*.sqlite`.

**Remediation.**

- Service not registered: `proxai-gateway setup` (which writes the unit) or
  `proxai-gateway start` (which bootstraps if absent).
- Service registered but stopped: `proxai-gateway start`.
- Sentinel present: see the dedicated entries below.
- No source files exist: nothing to capture; install or use the agent first.

## Captures buffered but not visible in the dashboard

**Symptom.** `proxai-gateway status` shows `delivered` rising; dashboard view
of the host is empty or stale.

**Diagnosis.**

1. Confirm the host_id in `~/.proxai/config.toml` matches what the dashboard
   expects for this machine.
2. Verify the ingestion key is still active (a revoked key would surface as
   `AUTH_FAILED`, but a key that was rotated to a different account silently
   ships to the new account):
   - `proxai-gateway tail --since 1d --level error` for any `auth.*` events.
   - Run `proxai-gateway setup` and observe whether the verify-key step
     reports `host_id stable` (same user as before) or
     `host_id rederived for new user` (different account).
3. Confirm the gateway is talking to the right nest base URL. If
   `[backend]` was overridden in config or `PROXAI_NEST_URL` is set, ensure
   the dashboard you are looking at corresponds to the same backend.

**Remediation.**

- If host_id rederived for new user, the new account is the one receiving
  records — log into that dashboard, or reinstall with the correct ingestion
  key.
- If the backend URL is wrong, edit `[backend]` in `~/.proxai/config.toml` and
  `proxai-gateway restart`.

## `AUTH_FAILED` sentinel — daemon halted on auth

**Symptom.** Cycles short-circuit; `proxai-gateway tail --level error
--since 1h` shows `auth.invalid` entries; `~/.proxai/AUTH_FAILED` exists.

**Cause.** The uploader received a 401/403 from nest, ran a reactive
`verify-key`, and verify-key also rejected the key. The ingestion key is
invalid, revoked, or the wrong type (a `SERVICE` key instead of `INGESTION`).
See SYSTEM_DESIGN.md §6.

**Remediation.**

1. Generate a fresh ingestion-type API key in the ProxAI dashboard.
2. `proxai-gateway setup`. Setup will detect the existing config and require
   double-entry of the new key. A successful `verify-key` clears the
   `AUTH_FAILED` sentinel.
3. The daemon's next poll cycle resumes; pending batches retry under the new
   key (the local cursor is unchanged, so no data was lost).

Do not delete the sentinel manually — the next cycle would re-write it as
soon as the next upload fails. The sentinel is a symptom, not the disease.

## `BUFFER_FULL` sentinel — pending pressure paused capture

**Symptom.** `proxai-gateway status` reports `buffer_full: yes`;
`pending_bytes` is near or above `bufferSoftPauseBytes` (default 700 MiB).
Cycles short-circuit until pressure drops.

**Cause.** Sustained network outage, sustained 4xx/5xx from the server, or
sustained 429-driven pacer backoff has accumulated more than the threshold of
pending bytes. The gateway intentionally stops reading new bytes from sources
to bound disk usage.

**Diagnosis.**

1. `proxai-gateway tail --level warn --since 1h`. Look for `upload.retriable`,
   `upload.rate_limited`, `upload.fatal`, or `upload.unknown_error` to identify
   the proximate cause.
2. Verify the network is up and the nest URL is reachable:
   `curl -I <ingest_url>` (the request will return 405 or 401 — that is
   expected; what matters is that you get a response).

**Remediation.**

- Network outage: nothing to do. Once connectivity returns, drain proceeds and
  the sentinel clears automatically when pending drops below
  `bufferSoftResumeBytes` (default 600 MiB). The 100 MiB hysteresis prevents
  flapping.
- Sustained 429: the pacer is already backing off. Operationally, raise
  `upload_max_bytes_per_minute` only after coordinating with the backend team.
- Stuck on a fatal-failed batch: `markBatchFailed` does not block drain;
  failed batches are skipped. If you suspect a corrupt pending batch is
  blocking, inspect with `sqlite3 ~/.proxai/buffer.db "SELECT capture_id,
  source_app, last_error, attempts FROM upload_batches WHERE status='pending'
  ORDER BY created_at;"`.

Manual intervention: `rm ~/.proxai/BUFFER_FULL` clears the sentinel
immediately, but the next cycle's pressure check will re-write it if pending
is still above the threshold. Use only as a debugging aid.

## `PAUSED` sentinel — manual or stale-binary halt

**Symptom.** `proxai-gateway status` reports `status: PAUSED`. Cycles
short-circuit.

**Cause.** Either the operator ran `proxai-gateway pause`, or the
stale-binary check tripped (`pauseAfterDays`, default 60 days since install).

**Diagnosis.** Read the sentinel file: `cat ~/.proxai/PAUSED`. The reason
field distinguishes manual from automatic pause.

**Remediation.**

- Manual pause: `proxai-gateway resume`.
- Stale binary: upgrade the binary and run `proxai-gateway setup`. Setup
  refreshes `installed_at` and clears the sentinel via the verify-key path.
  As a one-cycle escape hatch, `proxai-gateway resume` works, but the next
  cycle will re-pause if the binary is still older than `pauseAfterDays`.

## Suspected secret leaked into a capture

**Symptom.** A user reports a key or token in the dashboard that should have
been redacted, or a security review flags a captured record.

**Diagnosis.**

1. `proxai-gateway redaction list --categories` shows the active categories
   and rule counts. Confirm the relevant category is enabled (it always is —
   there is no per-category disable, but this verifies the binary's corpus).
2. `proxai-gateway redaction test <file>` runs the same regex corpus over a
   sample input and prints the redacted output. Use this to confirm whether
   the gateway *would* have redacted the same string.
3. If `redaction test` does not redact, the rule corpus is missing coverage
   for that secret format. If it *does* redact, the captured record predates
   the rule corpus update — old captures are not retroactively re-redacted.

**Remediation.**

- Server-side defense in depth: nest re-runs the rule corpus on receive
  (see `planning/nest-contract.md` §10). Even if the gateway missed it, nest
  catches it and emits a metric. Coordinate with the backend team to confirm.
- Add the missing rule pattern to `services/redaction/rules/<category>.ts`
  and ship a release. The gateway's bundled rules are the contract.
- For the existing captured record: the dashboard or backend team handles
  retroactive redaction; the gateway has no remediation primitive for already
  delivered records.

## Need to ingest history older than 30 days

**Symptom.** First-time install on a machine with deep agent history; you
want to ingest sessions from before the default 30-day initial-scan cap.

**Remediation.**

```sh
proxai-gateway backfill --since 90d
proxai-gateway backfill --since 6mo
proxai-gateway backfill --since 1y
```

Backfill runs a single poll cycle with the discovery mtime cap explicitly
overridden to `now - duration`. Captured batches enter the buffer and drain
through the same pacer as a normal cycle — large backfills may take a while
to ship at 50 MiB/min. The command prints whether the daemon will drain
them in the background or whether `proxai-gateway start` is needed.

Backfill respects existing cursors: files that are already past their
captured watermark stay where they are. Only the *discovery* lower bound is
relaxed.

## Diagnosing a single failing batch by `capture_id`

**Symptom.** A specific batch keeps failing; want to know what's in it.

**Diagnosis.**

1. Find it in the buffer:
   ```
   sqlite3 ~/.proxai/buffer.db
     "SELECT capture_id, source_app, source_path, watermark_kind,
             watermark_start, watermark_end, status, attempts, last_error,
             created_at
        FROM upload_batches
       WHERE capture_id LIKE 'prefix%';"
   ```
2. The body is a `BLOB` column with zstd-compressed redacted bytes. Inspect
   it locally without shipping:
   ```
   sqlite3 ~/.proxai/buffer.db
     "SELECT writefile('/tmp/batch.zst', body)
        FROM upload_batches WHERE capture_id = '<id>';"
   zstd -d /tmp/batch.zst -o /tmp/batch.txt
   head /tmp/batch.txt
   ```
3. Pass the `capture_id` to the backend on-call team — nest emits structured
   logs tagged with `capture_id` at every async boundary
   (see `planning/nest-contract.md` §13).

## Daemon won't start

**Symptom.** `proxai-gateway start` returns success but `status` shows the
service is not running, or the platform supervisor reports the service crashed.

**Diagnosis.**

1. Run the daemon in the foreground to surface the startup error directly:
   ```sh
   proxai-gateway run --config ~/.proxai/config.toml
   ```
   Errors that prevent loop entry (config validation, buffer-DB open failure,
   logger init) print to stderr.
2. If the run command starts but immediately exits, the service unit may be
   pointing at the wrong binary path. Re-run `proxai-gateway setup` to
   regenerate the unit.
3. On macOS only: a stale `launchd` registration can refuse to restart. Try
   `launchctl bootout gui/$(id -u)/co.proxai.gateway` then
   `proxai-gateway start`.

## Resetting the local buffer

**Symptom.** Need to start from a clean slate, e.g. after a config corruption
or a buffer DB schema migration that didn't auto-apply.

**Remediation.**

```sh
proxai-gateway stop
rm ~/.proxai/buffer.db ~/.proxai/buffer.db-wal ~/.proxai/buffer.db-shm
proxai-gateway start
```

The next cycle's watermark sync (see SYSTEM_DESIGN.md §4) seeds cursors from
the server, so captures resume at the server's known watermarks rather than
re-shipping history. No data loss; expect a small idempotent-retry blip on
the first cycle if any in-flight batches existed at stop time.

Do **not** delete `config.toml` — that drops the host_id derivation chain
unnecessarily; reinstalls from scratch require the operator to re-enter the
ingestion key. Deleting only the buffer database is the lighter operation.

## Inspecting structured logs without `tail`

**Symptom.** Need to grep across many days of history, or programmatically
process log entries.

**Remediation.** Logs are NDJSON; one event per line. Files live under the
configured `log_dir` (default per platform; see CONFIG_REFERENCE.md), with
filenames like `structured.YYYY-MM-DD.1.log`. Standard tools work directly:

```sh
# Count cycle.complete events per day
for f in ~/Library/Logs/proxai-gateway/structured.*.log; do
  echo "$f: $(grep -c '"event":"cycle.complete"' "$f")"
done

# All upload errors in the last 7 files, with capture_id
ls -t ~/Library/Logs/proxai-gateway/structured.*.log | head -7 \
  | xargs cat \
  | jq -c 'select(.event == "upload.fatal" or .event == "upload.unknown_error")
            | {time, capture_id, source_app, error}'
```

The CLI `tail --json` mode emits the same NDJSON for piping into ad-hoc
filters.
