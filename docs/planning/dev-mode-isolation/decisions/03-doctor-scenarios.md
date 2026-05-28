> STATUS: IMPLEMENTED on dev-mode-isolation (2026-05-28). See ../README.md for the commit map.

Catalog for the planned `doctor` command ([02-commands-and-retention.md](./02-commands-and-retention.md)
point 4). The user's hard requirement: **trustworthy attribution** — doctor
must never report "cause is A" when the real cause is B. So every scenario
below pairs a DEFINITIVE signal (a sentinel file, a DB counter, a
service-manager state, an fs/permission check, a version/mtime) with an
explicit DISAMBIGUATOR that separates it from look-alike causes, plus a
confidence label.

## Design principles for reliable attribution

1. **Read definitive signals, not inferences.** A sentinel file existing is
   definitive; "uploads seem slow" is not.
2. **Disambiguate before concluding.** When two causes share a symptom,
   doctor reads the distinguishing signal first. The canonical example is
   auth: `AUTH_FAILED` sentinel = real key problem (FATAL, server said no);
   repeating `upload.auth_unconfirmed` events with `AUTH_FAILED` absent =
   network failure during `verifyKey`, NOT a key problem. A naive doctor
   would say "bad key" for both — that's the exact misattribution to avoid.
3. **Confidence labels:** CONFIRMED (definitive signal present) vs LIKELY
   (inferred — doctor prints what it checked and what it couldn't rule out).
   Never present LIKELY as CONFIRMED.
4. **Output is structured + copy-pasteable + includes the raw signals read**
   so the team can re-derive the conclusion from the evidence, and so chronic
   bugs (e.g. a parser emitting ValidationErrors) surface with their evidence.
5. **Per-profile.** Doctor runs per profile (prod by default, `--profile dev`,
   or both). Each daemon has its own sentinels/buffer/state.
6. Doctor is READ-ONLY and side-effect-free (like `redaction test` /
   `inspect`). It never writes the buffer or clears sentinels.

## Observable signals doctor can read

Config presence + parse; account key present. Service-manager: unit
registered? process running? Sentinels (per profile): AUTH_FAILED,
BUFFER_FULL, SESSION_STOPPED, CONSENT_ACCEPTED, UPDATE_AVAILABLE. Buffer
counters: pending count/bytes, failed count, receipts count, quarantined
count, last_prune_at. daemon_state: capture/drain/heartbeat cycle counters
+ last-cycle timestamps, lastConsecutiveRetriableBreak, last error.
Binary: version, mtime/age, install_source. Recent structured-log events
(auth.invalid, upload.auth_unconfirmed, upload.rate_limited,
upload.retriable, upload.fatal, drain.cycle.skipped, buffer.soft_pause,
vacuum.detected, auto_upgrade.*). Filesystem: configDir/logDir writable,
disk free. Network: reachability of `defaultNestBaseUrl` (verify-key ping).
Source paths: do the coding-agent dirs exist. Clock/UTC sanity.

## Scenario catalog

### A. Lifecycle / not running
- **A1 Not set up.** Signal: profile `config.toml` absent. CONFIRMED →
  "run setup". Disambiguate from A3/A4 (config present).
- **A2 Set up but service unit not registered.** Signal: config present,
  service-manager reports unit not registered. CONFIRMED → "run start /
  setup --force". Disambiguate from A1 (no config) and A3 (registered).
- **A3 Stopped by user.** Signal: unit registered, process not running,
  `SESSION_STOPPED` present. CONFIRMED → "run start". Disambiguator vs A4:
  the SESSION_STOPPED sentinel.
- **A4 Crashed / failed to spawn.** Signal: unit registered, process not
  running, `SESSION_STOPPED` ABSENT. CONFIRMED-it-is-down / LIKELY-crash →
  surface last fatal log lines; "restart, send logs". Disambiguator vs A3:
  absence of SESSION_STOPPED.
- **A5 Wedged (running but not cycling).** Signal: process running but
  `capture_cycles_total` / last-cycle timestamp stale (> 2× the interval).
  LIKELY-hung → restart + capture logs. Disambiguate from A3/A4 (process
  actually down) and from C/D (cycling but failing downstream).

### B. Auth
- **B1 Invalid/revoked key (FATAL).** Signal: `AUTH_FAILED` present.
  CONFIRMED → "setup --force with a valid key; verify at proxai.co".
- **B2 Auth-unconfirmed loop (NETWORK, not key).** Signal: repeating
  `upload.auth_unconfirmed` events AND `AUTH_FAILED` absent. CONFIRMED-
  network → "check connectivity to <endpoint>; this is NOT a key problem."
  THE key disambiguation — never report B2 as B1.

### C. Upload blocked / slow
- **C1 Server rate-limiting this host.** Signal: pending rising + drain
  advancing + `upload.rate_limited` with large `retry_after_ms`
  (> 300_000). CONFIRMED → "contact ops with host_id". Disambiguate from C2
  by event kind.
- **C2 Network/DNS/TCP failure to endpoint.** Signal: `upload.retriable`
  kind=NetworkError, or verify-key ping fails, `http_status: null`.
  CONFIRMED → "endpoint unreachable from host; check network/proxy/SSL
  inspection". Disambiguate from C1 (429 with retry-after) and B2 (auth
  events).
- **C3 Drain wedged, no sentinel.** Signal: pending rising + drain cycles
  NOT advancing + no gating sentinel. LIKELY → restart. Disambiguate from
  C1/C2 (drain advancing but failing) and from sentinel-gated states.
- **C4 Buffer recovery in progress (healthy).** Signal: `BUFFER_FULL`
  present + drain advancing + pending bytes falling. CONFIRMED-healthy →
  informational, "working as designed, will self-clear". Must NOT be
  reported as a problem.
- **C5 Buffer pressure oscillating (drain too slow).** Signal: repeated
  `buffer.soft_pause`/`buffer.soft_resume` pairs. CONFIRMED → "raise
  upload_max_bytes_per_minute". Disambiguate from C4 (one-directional
  recovery).
- **C6 Parser emitting invalid records (CHRONIC BUG).** Signal: failed
  count rising + `upload.fatal` kind=ValidationError; cross-check by
  re-running validation via inspect. CONFIRMED-bug → surface
  source_app + sample, "send this doctor output to the team". This is the
  chronic-bug-catcher the user wants.
- **C7 Oversized rows quarantined.** Signal: `quarantined_records` count >
  0 / `OversizedDecompressedSliceError`. CONFIRMED → informational, those
  rows (>10 MiB) are skipped by design.

### D. Capture not happening
- **D1 No agent activity / source dirs absent.** Signal: capture cycles
  advancing but pending=0 & receipts=0 over a long window; source dirs
  (~/.claude, cursor, codex, gemini) missing or empty. LIKELY-no-activity
  → distinguish "no agent installed" vs "installed, no sessions yet" vs
  "capture broken" by checking which source dirs exist and have files.
- **D2 One source erroring.** Signal: `source.poll` error events scoped to
  one app. CONFIRMED-per-source → that parser/app-format issue; name the
  source. Disambiguate from D1 (global no-capture).

### E. Binary / upgrade
- **E1 Stale binary + upgrades failing.** Signal: binary age ≥60d +
  recent `auto_upgrade.{check_failed,no_asset,download_failed,write_failed}`.
  CONFIRMED → branch on the specific auto_upgrade event (each has a
  distinct cause; do NOT lump them).
- **E2 Brew update pending (healthy).** Signal: `UPDATE_AVAILABLE` present
  + install_source=brew. CONFIRMED → "run brew upgrade". Not a fault.
- **E3 write_failed: disk full vs permission mismatch.** Signal:
  `auto_upgrade.write_failed`; disambiguate by disk-free check (full) vs
  binary-path writability vs install/runtime-uid mismatch. Report the
  specific one, not a generic "upgrade failed".
- **E4 Success logged, old version running.** Signal: `auto_upgrade.success`
  but `--version` old + binary mtime recent. LIKELY service-manager didn't
  cleanly restart / wrapper-path overwrite. Distinguish by binary mtime
  (recent = restart issue; old = wrote to wrong path).

### F. Filesystem / environment
- **F1 configDir not writable (EACCES).** Signal: write probe / stat.
  CONFIRMED → fix permissions.
- **F2 Disk space low.** Signal: free bytes under threshold. CONFIRMED →
  "free space; buffer can't grow and upgrades will fail." Cross-links E3/C5.
- **F3 logDir not writable.** Signal: stat/probe. CONFIRMED → logging
  degraded.
- **F4 Clock/UTC skew.** Signal: system clock vs monotonic / large drift.
  LIKELY → watermark/timestamp anomalies possible.
- **F5 (Linux) no systemd / no linger.** Signal: systemctl absent, or unit
  present but linger off on a headless host. CONFIRMED → daemon stops when
  logged out; "loginctl enable-linger".
- **F6 (Windows) USERDOMAIN/USERNAME unresolvable.** Signal: env probe.
  CONFIRMED → task creation context issue.
- **F7 (macOS) quarantine xattr on binary.** Signal: `com.apple.quarantine`
  present. CONFIRMED → "xattr -d".

### G. Data integrity (the user's "indicators stuck at zero" worry)
- **G1 Counter shows zero but underlying data exists.** Signal:
  cross-check each status counter against its source table — e.g.
  `upload_total_batches_shipped == 0` BUT `upload_receipts` has rows ⇒ the
  COUNTER is broken/unwired, not the data. CONFIRMED-counter-bug → surface
  exactly which counter disagrees with which table. This directly answers
  "some indicators stay at zero and it worries me": doctor proves whether
  zero is true-empty or a wiring bug.
- **G2 buffer.db corrupt/unreadable.** Signal: SQLite open/integrity error.
  CONFIRMED → restore from backup / `uninstall --reset`.
- **G3 Watermark regression loop.** Signal: repeated regression-handshake
  recoveries for the same source_path_hash. LIKELY → cursor/server
  mismatch (stale-backup or duplicate-host); usually self-heals once.

## Output shape (proposed)

Per profile: a header (running? version? profile?), then a list of
findings each as `[CONFIRMED|LIKELY] <code> <one-line cause> → <action>`,
then a `Signals` appendix dumping the raw values doctor read (sentinels,
counters, timestamps, recent event tallies). Healthy checks listed too
(so "everything fine" is also a trustworthy, copy-pasteable result). The
whole thing must be copy-pasteable plain text the user can send to the team.

## When implementing
Each scenario = one small pure checker `(signals) => Finding | null`,
unit-tested against fabricated signal fixtures (DI; no real SQL per project
rules). Compose them; doctor runs all, sorts by severity. The disambiguation
pairs above are the test cases that MUST exist (e.g. a test that B2 with
AUTH_FAILED absent is reported as network, never as bad-key). Get the user
to review/augment this catalog before building.
