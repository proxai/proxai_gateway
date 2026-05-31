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

### A — Lifecycle / not running
- **A1** Config absent → not set up.
- **A2** Config present, unit not registered → "run start / setup --force".
- **A3** Unit registered, process not running, `SESSION_STOPPED` present → stopped by user.
- **A4** Unit registered, process not running, `SESSION_STOPPED` absent → crashed/failed to spawn.
- **A5** Process running but last-cycle timestamp stale > 2× interval → wedged.

### B — Auth
- **B1** `AUTH_FAILED` present → CONFIRMED bad/revoked key.
- **B2** `AUTH_FAILED` absent + `authUnconfirmedCount > 0` → CONFIRMED network failure, NOT a key problem.

### C — Upload blocked/slow
- **C1** `upload.rate_limited` with large `retry_after_ms` → server rate-limiting this host.
- **C2** `upload.retriable` kind=NetworkError or verify-key ping fails → endpoint unreachable.
- **C3** Pending rising + drain not advancing + no gating sentinel → drain wedged.
- **C4** `BUFFER_FULL` present + drain advancing + pending bytes falling → healthy recovery (informational, not a fault).
- **C5** Repeated `buffer.soft_pause`/`buffer.soft_resume` pairs → drain too slow for capture rate.
- **C6** Failed count rising + `upload.fatal` kind=ValidationError → parser emitting invalid records (CHRONIC BUG — surface for the team).
- **C7** `quarantined_records` count > 0 → oversized rows skipped by design (informational).

### D — Capture not happening
- **D1** Capture cycles advancing but pending=0 & receipts=0 over a long window → no agent activity or source dirs absent.
- **D2** `source.poll` error events scoped to one app → single-source parser/format issue.

### E — Binary / upgrade
- **E1** Binary age ≥60d + recent `auto_upgrade.*failed` events → stale binary + upgrade failing (branch on specific event for cause).
- **E2** `UPDATE_AVAILABLE` + install_source=brew → brew upgrade pending (informational, not a fault).
- **E3** `auto_upgrade.write_failed` → disambiguate by disk-free (full), binary-path writability, uid mismatch.
- **E4** `auto_upgrade.success` logged but `--version` old + binary mtime recent → service manager didn't cleanly restart.

### F — Filesystem / environment
- **F1** configDir not writable → fix permissions.
- **F2** Disk space low → free space; buffer can't grow, upgrades will fail.
- **F3** logDir not writable → logging degraded.
- **F4** Clock/UTC skew → watermark/timestamp anomalies possible.
- **F5** (Linux) systemd absent or linger disabled on headless host → daemon stops on logout.
- **F6** (Windows) USERDOMAIN/USERNAME unresolvable → task creation context issue.
- **F7** (macOS) `com.apple.quarantine` xattr on binary → "xattr -d".

### G — Data integrity
- **G1** Cross-check `upload_receipts` row count against any lingering `buffer_metadata` counter → if counter says zero but table has rows, it's a counter-wiring bug, not empty data.
- **G2** SQLite open/integrity error → buffer.db corrupt or unreadable.
- **G3** Repeated `resync_events` rows for the same `source_path_hash` in a short window → watermark-regression loop (stale backup, duplicate host, or vacuum storm).

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
