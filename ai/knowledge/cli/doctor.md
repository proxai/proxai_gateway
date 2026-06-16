# Doctor Command

`proxai-gateway doctor` is a read-only diagnostic command, prod-visible. It collects observable signals from sentinel files, the service manager, buffer DB, filesystem probes, and a network ping, then runs a catalog of per-scenario checker functions to produce structured, copy-pasteable output.

## Architecture

```
DoctorSignals (collected at gather-signals.ts) → all checkers → Finding[] → render
```

Each checker is a pure function `(signals: DoctorSignals) => Finding | null`. Signals are collected once (all wrapped in try/catch; `null` on failure). Findings are sorted by severity and rendered with a `[CONFIRMED|LIKELY]` label per the reliability principles below.

## Reliability principles

1. **Read definitive signals, not inferences.** A sentinel file existing is definitive; "uploads seem slow" is not.
2. **Disambiguate before concluding.** When two causes share a symptom, read the distinguishing signal first.
3. **Confidence labels:** `CONFIRMED` (definitive signal present) vs `LIKELY` (inferred — doctor prints what it checked and what it couldn't rule out). Never present `LIKELY` as `CONFIRMED`.
4. **Output includes the raw signals read.** A `Signals` appendix dumps the values doctor observed so the team can re-derive the conclusion.
5. **Per-profile.** Doctor runs per profile (prod by default, `--profile dev`). Each daemon has its own sentinels/buffer/state.
6. **Read-only and side-effect-free.** Doctor never writes the buffer or clears sentinels.

## The critical B1/B2 disambiguation

The single most important correctness property:

- **B1 Invalid/revoked key (FATAL):** `AUTH_FAILED` sentinel present → CONFIRMED bad key.
- **B2 Auth-unconfirmed loop (NETWORK, not key):** `AUTH_FAILED` absent AND `authUnconfirmedCount > 0` → CONFIRMED network/DNS issue.

A checker that reports B1 when `AUTH_FAILED` is absent is **wrong**. B2 must always say "this is NOT a key problem."

## Scenario catalog (full list)

### A — Lifecycle, Strays, and Process Issues
- **A1** Config absent → not set up.
- **A2** Config present, unit not registered (and not intentionally stopped) → "run start / setup new".
- **A3** Unit registered, process not running, `SESSION_STOPPED` present → stopped by user.
- **A4** Unit registered, process not running, `SESSION_STOPPED` absent → crashed/failed to spawn.
- **A5** Process running but last-cycle timestamp stale > 2× interval → wedged daemon.
- **A6** Abrupt termination → Daemon stopped without running clean exit routines (crashed or SIGKILL).
- **A7** Zombie daemon → Conflicting or orphaned background process running outside service manager.
- **A8** Graceful termination lockup → Daemon trapped in graceful shutdown socket draining.
- **A9** Helper process unhealthy → Native background helper processes crashed/uninitialized.
- **A10** Watcher thread lag/exhaustion → Thread pools saturated, watch directories too broad.
- **A11** Windows service unquoted path → Registry binPath contains spaces but is unquoted (privilege hijack risk).
- **A12** Windows Task Scheduler XML corrupt → Task Scheduler XML definition corrupt/unparseable.
- **A13** Systemd runtime directory missing → XDG_RUNTIME_DIR missing in non-interactive shell.
- **A14** Systemd rate limit hit → Service manager rate-limited the daemon (start-limit-hit).
- **A15** Systemd home encrypted tearing → User home directory encrypted, tearing down linger files on logout.
- **A16** Rescue circuit breaker tripped → Daemon failed to start >= 3 times consecutively.

### B — Auth and Security
- **B1** `AUTH_FAILED` present → CONFIRMED bad/revoked key.
- **B2** `AUTH_FAILED` absent + `authUnconfirmedCount > 0` → CONFIRMED network/DNS issue, NOT a key problem.
- **B3** Ingest key auth error → Upload failed with 403 or invalid key.
- **B4** Insecure API key transmission → SSL validation disabled (NODE_TLS_REJECT_UNAUTHORIZED=0).
- **B5** Permissive config permissions → Config file has overly permissive group/world write permissions.
- **B6** Overly broad directory watches → config.toml monitoring root or too many folders.

### C — Upload and Network
- **C1** `upload.rate_limited` with large `retry_after_ms` → Server rate-limiting this host.
- **C2** `upload.retriable` kind=NetworkError or verify-key ping fails → Endpoint unreachable.
- **C3** Pending rising + drain not advancing + no gating sentinel → Drain wedged.
- **C4** `BUFFER_FULL` present + drain advancing + pending bytes falling → Healthy recovery (informational, not a fault).
- **C5** Repeated `buffer.soft_pause`/`buffer.soft_resume` pairs → Drain too slow for capture rate.
- **C6** Failed count rising + `upload.fatal` kind=ValidationError → Parser emitting invalid records (CHRONIC BUG).
- **C7** `quarantined_records` count > 0 → Oversized rows skipped by design (informational).
- **C8** Outbound TLS inspection → Corporate proxy decryption detected (needs root CA export).
- **C9** Global proxy mismatch → OS HTTP proxy setting not inherited by daemon execution context.
- **C10** DNS hijack/captive portal → Network redirects DNS to private landing page/captive portal.
- **C11** Throttler reset clock skew → Clock skew > 30s causing invalid rate-limit calculations.
- **C12** Thundering herd jitter → Resync events executing retry loops in lockstep.
- **C13** Outbox timeouts → Network outbox experiencing persistent timeouts.

### D — Capture not happening
- **D1** Capture cycles advancing but pending=0 & receipts=0 over a long window → No agent activity or source dirs absent.
- **D2** `source.poll` error events scoped to one app → Single-source parser/format issue.
- **D3** Source capture errors → Continuous capture process crashes on specific apps.

### E — Binary, Paths, and Upgrade Lock
- **E1** Binary age ≥60d + recent `auto_upgrade.*failed` events → Stale binary + upgrade failing (branch on specific cause).
- **E2** `UPDATE_AVAILABLE` + install_source=brew → Brew upgrade pending (informational).
- **E3** `auto_upgrade.write_failed` → Disambiguate by disk-free (full), binary-path writability, uid mismatch.
- **E4** `auto_upgrade.success` logged but `--version` old + binary mtime recent → Service manager didn't cleanly restart.
- **E5** Upgrade lock stale → Stale .upgrade.lock blocking updates.
- **E6** Staged upgrade binary corrupt → Coordinate startup crashes from corrupted temp files.
- **E7** Homebrew relocation drift → Rosetta x64 emulation path collisions on Apple Silicon.

### F — Filesystem, Advanced FS, and Performance
- **F1** configDir not writable → Fix permissions.
- **F2** Disk space low → Free space; buffer can't grow, upgrades will fail.
- **F3** logDir not writable → Logging degraded.
- **F4** Clock/UTC skew → Watermark/timestamp anomalies possible.
- **F5** (Linux) systemd absent or linger disabled on headless host → Daemon stops on logout.
- **F6** (Windows) USERDOMAIN/USERNAME unresolvable → Task creation context issue.
- **F7** (macOS) `com.apple.quarantine` xattr on binary → "xattr -d".
- **F8** macOS TCC FDA blocked → Privacy & Security Full Disk Access missing.
- **F9** macOS Gatekeeper translocation → Binary translocated or quarantined by Gatekeeper.
- **F10** Sandboxed terminal locks → Gateway run within sandboxed editor terminal.
- **F11** Symlink traversal loop → Infinite symbolic link recursion inside monitored folders.
- **F12** POSIX Extended ACL blocked → Immutable attributes or custom ACL blocking writes.
- **F13** Broken Windows Junction → Junction points to offline volume/share.
- **F14** Log rotation inode drift → Tailing stale, unlinked log file after rotation.
- **F15** Physical write exhaustion → Volume remounted read-only (EROFS) or ran out of inodes (ENOSPC).
- **F16** Sudo hijack ownership drift → Root-level ownership on config/db folders.
- **F17** V8 sync event loop lag → High CPU sync delay (>100ms) blocking heartbeats/watchers.
- **F18** V8 heap exhaustion → Garbage collection thrashing under memory pressure.

### G — Data Integrity and SQLite Concurrency
- **G1** Cross-check `upload_receipts` row count against any lingering `buffer_metadata` counter → Broken counter wiring if mismatch.
- **G2** SQLite open/integrity error → buffer.db corrupt or unreadable.
- **G3** Repeated `resync_events` rows for the same `source_path_hash` in a short window → Watermark-regression loop.
- **G4** Non-WAL journal mode → Database journal set to rollback mode instead of WAL.
- **G5** Database busy timeout low → Busy timeout < 2000ms causing write lock conflicts.
- **G6** Database transaction lockup → Leaked transaction holding write locks.
- **G7** WAL checkpoint starvation → Unclosed read transaction blocks WAL truncation.
- **G8** Uncommitted journal stale lock → Zombie process holding WAL journal write lock.
- **G9** Inconsistent session UUIDs → Cloned IDE workspace database producing duplicate UUIDs.
- **G10** Telemetry zstd compression CPU spikes → Single telemetry cycle cpu spike > 1.5s.

## Output shape

Per profile: a header (running? version? profile?), then the `SIGNALS` appendix with the raw values doctor read, then a single `DIAGNOSTICS SUMMARY` of findings as `[CONFIRMED|LIKELY] <code> <one-line cause> → <action>`. Healthy checks are listed too — "everything fine" is also a trustworthy, copy-pasteable result.

Doctor has **one output mode** — always fully verbose, identical for regular and dev-mode users. There is no `--compact` flag and no abbreviated regular-user view: the whole point is that any user can paste the complete signals + summary for the team to debug. (The `--compact` global flag still applies to `status`/`logs`, just not `doctor`.) The summary is rendered once, not duplicated. In dev mode doctor additionally folds in the prod profile's findings with `[dev]`/`[prod]` prefixes (two daemons), but the section layout is the same.

## Files

```
src/cli/commands/doctor/
  index.ts            runDoctor entry point
  doctor.types.ts     DoctorSignals, Finding, FindingCode, severity enum
  gather-signals.ts   collect all signals from fs/db/service-manager/network
  checkers/           one file per scenario group
  render-doctor.ts    render findings + signals appendix
src/cli/wiring/doctor-deps.ts
```

[source: src/cli/commands/doctor/; src/cli/wiring/doctor-deps.ts; memory project_dev_mode_doctor_scenarios.md]
