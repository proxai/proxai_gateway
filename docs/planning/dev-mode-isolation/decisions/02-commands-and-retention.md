> STATUS: IMPLEMENTED on dev-mode-isolation (2026-05-28). See ../README.md for the commit map.

A second batch of requirements the user added on 2026-05-27, mid-execution
of Phase 1. These layer onto [01-architecture.md](./01-architecture.md) and are to be
implemented AFTER the Phase 1 foundation tasks complete. They reshape
Phase 2/3 and add new commands + a data-retention model change.

**Why:** The user wants the prod CLI to be clean and user-friendly (hide
developer-only surface), give end users genuinely useful self-service
output (status, logs, doctor), and stop throwing away data that makes
that output meaningful. They also want to be able to receive
copy-pasted `doctor` output from users to catch chronic bugs.

**How to apply** — the agreed requirements (verbatim intent):

1. **Command visibility gating.** When NOT in dev mode (regular prod
   user), commands that don't help end users must be hidden from
   `--help` and from the README. Specifically `dev` and `tail` are
   developer-only and never appear in help/README. Developers already
   know how to enable/use them. (Likely mechanism: commander
   `{ hidden: true }`, same as `run` today. This is a static help
   visibility decision, not a runtime gate — confirm.)

2. **Dev mode is invisible to prod users.** Dev mode and how to enable
   it must NOT show up in README or CLI helpers at all.

3. **status redesign — prod vs dev verbosity.**
   - Prod user `status`: simple, user-facing — local total data, how
     much uploaded so far, whether the app is running, last run cycle.
     NOT technical buffer internals.
   - When in dev mode: always show DETAILED status, showing BOTH dev
     and prod, clearly separated.
   - Both prod and dev status show the **last 5 uploads** by default.
   - (Open question: what triggers the "detailed both-profile" view —
     presence of a configured dev profile [`dev/config.toml` exists]?
     Since the dual-daemon model removed the ACTIVE_PROFILE marker,
     there is no "current mode" flag; "in dev mode" most likely means
     "a dev profile is configured/running." Confirm.)

4. **New `doctor` command.** Very smart, multiple utilities behind it.
   Hardcode all potential failure scenarios; when the app is stuck,
   produce meaningful diagnostic output. Runnable by prod users.
   Output is copy-pasteable so users can send it to the team to catch
   chronic bugs. (Candidate scenarios to hardcode, from existing
   runbooks: daemon not running / not registered; AUTH_FAILED; buffer
   pressure / BUFFER_FULL; stale binary; no captures in N time; upload
   failures / retriable backlog; disk space; permission errors on
   config/buffer/log dirs; sentinel inconsistencies; clock/UTC issues;
   source-app paths missing. Propose the full list when picking this
   up.)

5. **New `logs` command** (in addition to existing `tail`).
   - `tail` = advanced/technical output of the entire app's processes
     and working-principle phases. **Dev-only; hidden from prod.**
   - `logs` = simpler, record-centric view shown to BOTH prod and dev.
     Custom scenarios we often want, e.g. "last 10 logs uploaded" with
     meaningful per-record detail. Dev gets everything prod has plus
     more (dev is a superset of prod).
   - `logs --error` = all records in a warning / failed state — list
     of records and what happened to each. NOT the technical
     phase-by-phase output (that's `tail`'s job).
   - Exact column/field set for `logs` vs `tail` is still open for
     discussion; initial framing above.

6. **REVERSAL: keep user prompts after upload (don't delete all body
   data).** Previously the plan deleted body content post-upload. New
   decision: after a successful upload, KEEP the user's prompt text;
   DELETE source-app responses / outputs / assistant turns. Rationale:
   when displaying "last uploaded logs," the user recognizes which of
   their own prompt requests were uploaded. (Open questions: keep the
   REDACTED prompt only [almost certainly — never re-persist secrets];
   the prompt-vs-response boundary must be defined per source parser
   — claude-code / codex / cursor / gemini-cli each delimit
   user-vs-assistant turns differently. Confirm "redacted prompts
   only" and scope the per-source extraction.)

7. **Persist status statistics + record metadata permanently.** Some
   `status` indicators currently sit at zero, which worries the user —
   we must verify availability of all data and that the tool works
   correctly. Write all previous statuses and accumulated data into the
   DB. Unless the user runs `uninstall --reset`, ALWAYS keep
   uploaded / failed / pending records (or their metadata after upload)
   and all status statistics PERMANENTLY. (This CONTRADICTS today's
   pruning: receipts + failed batches are pruned after retention days,
   and `markBatchDelivered` deletes the batch keeping only a receipt.
   New model = permanent accumulation. Open tension: this is a buffer
   schema/data-model change. The user earlier said "forget about
   migrations" — but additive schema via the existing `columnExists`
   pattern is allowed without a full framework. Need to decide:
   additive-only, or does permanent stats finally justify a real
   migration system? Also: unbounded growth over years — is any cap
   acceptable, or truly permanent? Confirm.)

8. **`logs --error` detail.** Show every record in a warning/failed
   state with what happened to it. Record-list semantics, not app-phase
   technical trace.

9. **Sequencing.** The user instructed: finish the current in-flight
   agentic Phase 1 tasks FIRST (some subagent processes had stalled),
   THEN pick these up. They invited clarifying questions when picking
   these up. These belong AFTER the available Phase 1 tasks in the
   queue.

**Cross-impact on existing plans:**
- Phase 2 (`02-phase-2-migration-and-dev-daemon.md`) — already pending
  the command restructure; THIS is a big part of that restructure.
  Command visibility, `dev`, `tail` hidden, `logs`/`doctor` added,
  status redesign all land here or in a new phase.
- Phase 3 surfacing — status/logs/doctor user-facing output is the bulk
  of it now.
- A NEW concern not in the original 3 phases: the buffer data-model
  change for permanent retention + prompt-keeping + per-source prompt
  extraction. This may warrant its own phase/plan.

When picking this up, re-open brainstorming on points 4, 5 (logs/doctor
field sets) before writing the revised Phase 2/3 plans. Points 3, 6, 7
were RESOLVED on 2026-05-27 — see below.

## Resolved decisions (2026-05-27)

**Point 2/3 — status detailed-view trigger:** CONFIRMED. `status` shows
the detailed both-profile view when a dev profile is CONFIGURED via
setup (i.e. `dev/config.toml` exists). Otherwise simple prod-only view.

**Point 6/7 — retention model, anchored to the EXISTING metadata
cleanup strategy.** The current strategy (verified in code
2026-05-27):
- `upload_batches` holds the full body blob (base64(zstd(redacted_text)))
  while `pending`.
- On successful delivery, `markBatchDelivered` (batches.ts:158) inserts
  a lightweight `upload_receipts` row (METADATA ONLY: captureId,
  sourceApp, sourcePathHash, watermark range, deliveredAt,
  idempotentOnServer; ~200 B/row) and DELETES the batch — so the body
  (prompt + responses) is destroyed at delivery today.
- `failed` batches keep their body until pruned.
- `pruneBuffer` (prune.ts:58) runs each drain cycle: DELETE receipts
  older than `receiptRetentionDays` (default 30), DELETE failed batches
  older than `failedRetentionDays` (default 30), prune quarantined
  older than the failed cutoff. PENDING is never time-pruned.

The NEW model keeps that same collapse-to-metadata-at-delivery shape,
with two changes:
1. **At delivery, additionally retain the REDACTED user prompt** (not
   just receipt metadata). Strip source-app responses / assistant turns
   / tool outputs — keep only the user's prompt text, already redacted
   (never persist raw secrets; reuse the redaction the body already
   went through before upload). Likely an added column on the receipt
   row (or a parallel `delivered_records` table) carrying the redacted
   prompt. The prompt-vs-response boundary is per-source-parser work
   (claude-code / codex / cursor / gemini-cli delimit user vs assistant
   turns differently).
2. **Retain the metadata + redacted prompt for 1 YEAR** (corrected
   2026-05-27 from the earlier "permanent" — user decided 365 days).
   Raise the receipt retention from 30d → 365d rather than disabling
   the prune. `uninstall --reset` still wipes immediately.

Schema impact: additive (new column(s)/table via the existing
`columnExists` ALTER pattern, allowed without a migration framework) +
bumping the receipt retention default to 365d. Still-open retention
sub-questions: (a) for FAILED batches, keep metadata 1y but still drop
the body after the old `failedRetentionDays` to bound size? (b)
aggregate running-total counters (e.g. "total uploaded since install")
— keep those permanent since they're tiny and a lifetime total is
useful, or also 1-year-window them? (Per-record rows = 1y is decided;
this is only about the handful of cheap aggregate stats.) Confirm when
implementing.

## LOCKED: upload_receipts schema (2026-05-27)

Model: KEEP the two-table split (work queue `upload_batches` stays hot;
`upload_receipts` is the lean long-lived archive). Extend
`upload_receipts` with columns for display + dev/debugging + doctor.

**Hard principle (user, 2026-05-27):** only fields essential to
operations are `NOT NULL`; EVERY other field is nullable. A missing
value must render as empty and never break logs/doctor/the app.
Additive `ALTER TABLE ... ADD COLUMN` guarded by `columnExists`.
Pre-upgrade receipt rows will have NULL for all new columns — all
consumers must degrade gracefully.

Required (stay NOT NULL — drive dedup/watermark/delivery): `capture_id`
(PK), `source_app`, `source_path_hash`, `watermark_kind`,
`watermark_start`, `watermark_end`, `delivered_at`,
`idempotent_on_server`. (`watermark_table` already nullable.)

New columns, ALL NULLABLE (locked). NAMING (locked 2026-05-27): the
prompt column is `user_prompt` (not `redacted_prompt` — redaction is a
pipeline invariant so the name needn't carry it; content is still
redacted), and the activity-time column is `user_prompt_added_at` (not
`prompt_at_utc`) — CONFIRMED added.
- `user_prompt` TEXT — user's (redacted) prompt, per-source (option A)
  extraction at delivery, responses/outputs stripped. Display payload.
- `user_prompt_added_at` TEXT — when the user submitted the prompt,
  extracted from the body during option-A parsing (true activity time,
  better than `captured_at_utc` for user-facing "when"). CONFIRMED.
- `source_path` TEXT — raw absolute source path. Dev/doctor only
  (privacy-sensitive; do NOT show to prod users).
- `agent_schema_version` TEXT — provenance.
- `gateway_version` TEXT — which gateway CalVer shipped it.
- `captured_at_utc` TEXT — gateway capture (ingest) time.
- `attempts` INTEGER — upload attempts before success.
- `source_inode` INTEGER — rename/vacuum detection aid.

`shipped_bytes` INTEGER — LOCKED 2026-05-27 (promoted from optional):
required to derive "bytes uploaded" stats from rows (see statistics
section below). Still nullable per the principle; null rows just don't
contribute to the SUM.

Still proposed, NOT locked (assistant recommends; confirm):
`prompt_at_utc` TEXT (true activity time extracted from body alongside
the prompt — more accurate than `captured_at_utc` for user-facing
"when").

Display tiers (assistant decided, per user delegation):
- **USER** (prod `logs`/`status` last-N): `redacted_prompt` + a
  timestamp (+ optional size). Recognizable, non-technical only.
- **DEV** (dev-mode `logs`/`status`, or `--profile dev`): EVERYTHING —
  all columns (user: "devs should see all of them for any debugging").
- **DOCTOR**: uses `agent_schema_version` + `gateway_version`
  (provenance of failing records), `attempts` (retry pressure),
  `captured_at_utc` vs `delivered_at` (delivery lag), `source_path`
  (which file), `source_inode` (rename/vacuum) as evidence in its
  signal appendix.

Failed records: keep EVERYTHING (full body) by staying in
`upload_batches` as `status='failed'` (just bump failed retention to
~1y); successful → lean receipt + redacted prompt as above.

## LOCKED: statistics approach — derive from rows (Option 1) (2026-05-27)

Root cause of the "indicators stuck at zero" bug: `buffer_metadata`
cumulative counters (`drain_total_batches_shipped`, per-source totals,
`cycles_total`, …) are app-side read-modify-write done at cycle end,
OUTSIDE the delivery transaction, in a swallow-on-error try/catch, as
TEXT. So they silently fall behind the authoritative rows
(`upload_receipts`). `status`'s derived `history` trusts the counter and
never cross-checks the table.

Decision (user, 2026-05-27): **Option 1 — derive all cumulative stats
from the tables; drop the cumulative counters entirely.** Chosen for
simplicity + full reliability (no drift by construction) over the
hybrid. The only "cost" — totals are a rolling 12-month window (because
receipts prune at 1y) — is acceptable; lifetime totals are not needed.

Precise shape (NOT the chaotic hybrid):
- **Drop every cumulative counter.** Totals come from `COUNT`/`SUM` over
  rows at read time:
  - records uploaded (12mo) = `COUNT(*)` over `upload_receipts`
  - bytes uploaded (12mo) = `SUM(shipped_bytes)` over `upload_receipts`
    (this is why `shipped_bytes` is now a locked receipt column)
  - per-source = `… GROUP BY source_app`
  - last success = `MAX(delivered_at)`
  - pending / failed = `COUNT`/`SUM` over `upload_batches` (already done)
  - quarantined = `COUNT` over `quarantined_records` (already done)
- **captured vs uploaded (the healthy-match goal):**
  `captured = SUM(receipts.shipped_bytes) + pending body bytes +
  failed body bytes`; `uploaded = SUM(receipts.shipped_bytes)`. So
  `captured − uploaded = pending + failed` — they match exactly when
  caught up. pending/failed are the ONLY honest divergence explainers.
- **Idempotent receipts counted in BOTH captured and uploaded** (user
  confirmed 2026-05-27 — do NOT exclude). Excluding from uploaded only
  would break the match (captured > uploaded even when healthy). They
  are real bytes the gateway shipped. A cheap honest footnote may show
  "(N re-sent duplicates)" via `COUNT WHERE idempotent_on_server = 1`,
  but it usually reads ~0.
- **Keep ONLY the last-event markers** in `buffer_metadata` — single
  overwritten values, NOT counters, no drift, nothing to derive them
  from: `capture_last_cycle_at`, `drain_last_cycle_at`,
  `last_version_check_at`, `latest_known_version`, `last_prune_at`.
  Daemon liveness = service-manager running state + these timestamps.
- Naturally per-profile (each profile has its own buffer.db).

**Re-sync visibility — LOCKED option (iii) + new `resync_events` table
(2026-05-27).** Today a watermark-regression recovery (the post-reset /
stale-backup / dual-host path: server is ahead → 400 watermark_regression
→ `setCursorFromRegression` + deleteBatch + outcome `recovered`) just
fast-forwards the cursor and persists nothing (no receipt). To let the
user SEE that skips fire (verify the mechanism) and to feed doctor, add
a small additive table:

`resync_events` (CREATE TABLE IF NOT EXISTS — no migration framework):
- `source_app`, `source_path_hash` — which source re-synced
- `watermark_kind` — unit (byte_range vs rowid_range)
- `server_watermark_end` — where the server was
- `skipped_units` — `server_watermark − gateway_watermark` (how far it
  fast-forwarded past data the server already had)
- `recovered_at` — timestamp

Derive-from-rows like everything else (no counter): status shows
"re-synced with server: N sources, last at TIME" (verification after a
reset); kept OUT of the captured/uploaded byte totals (`skipped_units`
is in SOURCE bytes/rowids, not compressed-uploaded bytes — mixing would
mislead). Retention 1y; `--reset` wipes. **Doctor scenario G3
(regression loop) derives directly from this table** — many resync_events
for one `source_path_hash` in a short window = stale-backup loop /
dual-host / vacuum storm.

Implementation notes:
- Perf: local SQLite COUNT/SUM over ≤1y of rows is ms-scale; if ever
  slow for a power user, add covering index `(source_app, delivered_at,
  shipped_bytes)` or a cached rollup. Not needed by default.
- Label window honestly in UI ("last 12 months", not "all time").
- Doctor G1 cross-check is now trivial — if any legacy `buffer_metadata`
  counter row lingers and disagrees with the table count, the table
  wins; counters are no longer a source of truth.

## LOCKED: command surface, visibility, logs/tail UX (2026-05-27)

**Command visibility.**
- Prod-visible: `setup`, `start`, `stop`, `restart`, `status`, `logs`
  (new), `doctor` (new), `upgrade`, `uninstall`.
- Dev-only, HIDDEN from `--help` + README but still functional
  (commander `{ hidden: true }`): `run` (already), `dev`, `xstate`,
  `tail`, `inspect`, `redaction`, `replay`. (User agreed to hide the
  debug trio inspect/redaction/replay.)
- **Dynamic unhide = "god mode": keyed off the dev-mode FLAG** (see the
  FINAL model below), not config existence and not daemon state.

### FINAL dev-mode model (user decision 2026-05-28 — overrides earlier)

Dev mode is an explicit, BOOT-SCOPED CLI-PERSPECTIVE toggle. It is NOT
tied to config existence or daemon lifecycle.

- **Two daemons, lifecycle independent of dev mode.** prod + dev each
  have their own config/unit/buffer/URL and run independently. The dev
  daemon keeps capturing local activity → local nest CONTINUOUSLY for
  debugging, whether or not the CLI is in dev mode. Reason the user
  keeps it running: they develop locally and want local data captured
  by local nest at all times.
- **The flag** is set by `dev on`, cleared by `dev off`. Controls only
  the CLI perspective: which profile commands target, status/logs
  detail, and god-mode command visibility.
  - Persists across manual daemon stop and `setup` cleans — only
    `dev off` exits dev mode.
  - Resets to OFF on reboot (on-demand only; having dev configs ≠
    booting into dev mode).
  - Not derived from config existence.
  - Mechanism: boot-scoped marker storing `readBootId()`; in dev mode
    iff marker exists AND boot_id matches current (mismatch = rebooted
    = off). Reuses the SESSION_STOPPED boot_id pattern → REVISE the
    sentinel rule that says "do not replicate boot_id self-clearing";
    the dev-mode flag is a sanctioned second user. The root `DEV_MODE`
    file is repurposed as this flag (its old Phase-1 URL-flip use is
    dead — each daemon's URL now comes from its own profile config).
- **`dev on`:** set flag (current boot_id); if dev configured,
  AUTO-START the dev daemon; unlock god mode. If dev not configured,
  you're in dev mode and `setup` configures dev.
- **`dev off`:** clear flag; re-hide to prod surface; prod perspective.
  Does NOT stop the dev daemon — it keeps running.
- **Auto-start everywhere, NEVER auto-stop.** Invariant (CONFIRMED
  2026-05-28): the dev DAEMON auto-starts whenever a dev config exists
  (boot, soft reinstall, `dev on`); dev MODE never auto-activates —
  always on-demand via `dev on`. So: Boot → start both configured
  daemons, dev mode OFF. Soft reinstall (no `--reset`, dev config
  present) → start the dev daemon too, dev mode OFF (regular-user
  experience). `dev on` → start dev daemon if configured + enter dev
  mode. Coordinated upgrade → transient stop+restart (ends running, not
  a durable stop). All durable stops are MANUAL.
- **Commands follow the current perspective.** In dev mode: `setup` →
  dev config (`setup prod` overrides); `status`/`logs`/`stop`/`start`/…
  default to the dev profile; detailed both-profile status; full
  command surface visible. Out of dev mode: `setup` → prod (regular);
  prod profile; simple prod-only status; prod surface only. Explicit
  override always: `setup prod` / `setup dev`, `--profile <name>`.

**Supersedes:** (1) dual-daemon "no marker, service-manager state is
truth" — there IS a dev-mode flag now, distinct from daemon state;
(2) "status detailed view when dev configured" → now keyed off the dev-
mode flag; (3) the A/B visibility question → answer is (C) the explicit
boot-scoped flag; (4) "dev off stops the dev daemon" → NO, never; (5)
Phase-1 `resolveNestBaseUrl` DEV_MODE URL-flip stopgap is dead, remove
when building the command surface. All of this is COMMAND-SURFACE work
(parked behind the restructure); no landed data-layer code changes.

**Watch-mode default (tail + logs).**
- BOTH `tail` and `logs` default to WATCH mode (live).
- REMOVE `--follow` (watch is the default now).
- ADD `--static` — one-shot render, no watch.
- `--json` (and other capture/output flags) imply `--static` (can't
  stream JSON for capture).
- `status` is already watch-by-default — now consistent across all three.

**`logs` command (strong options).** Record-centric, reads buffer.db
(`upload_receipts`/`upload_batches`/`resync_events`), NOT pino logs.
- Default (watch): last N uploaded records. User tier: time
  (`user_prompt_added_at`) + source + `user_prompt` snippet + size.
  Dev tier: all receipt columns.
- Option set (strong): `--static`, `--json` (→static), `--error`
  (failed/warning records + what happened), `--source <app>`,
  `--since <dur>`, `--pending` (queued not-yet-shipped), `--lines <n>`.
  Extend when building.
- `--error` = per-record failure ledger (failed batches + quarantined +
  repeated resyncs), NOT the app-phase trace (that's `tail`'s job).

**Prompt extractors — build ALL now, fault-tolerant (in progress).**
Per-source redacted-prompt extraction for all 4 sources, built now (not
deferred). Extraction at DELIVERY (decompress batch body → per-source
parse → `user_prompt` + `user_prompt_added_at`), bounded by pacer rate.
Fault-tolerant + simple: any parse failure / missing / unknown shape →
`null` (column renders empty). NEVER throw into the delivery path.

**tail stays on pino files (NOT buffer.db) — reaffirmed.** pino writes
NDJSON rotating files (via pino-roll) for the daemon's high-volume,
ephemeral event stream → `tail` reads those. buffer.db holds the
durable record ledger → `logs` reads that. Do NOT merge: different
volume, lifecycle, write-perf (pino append vs SQLite INSERT contending
the single-writer upload WAL), rotation/pruning, crash-safety, and
external consumability. The durable diagnostics doctor needs (failed
batches, last_error, resync_events) are ALREADY in the DB; the pino
stream is the transient phase trace.

## Doctor command scenarios

Full reliability-focused catalog saved separately:
[03-doctor-scenarios.md](./03-doctor-scenarios.md).
