# Services overview

The `src/services/` tree is the daemon's modular runtime. Nine modules cooperate through three coordination surfaces only: rows in `buffer.db`, sentinel files under `configDir()`, and the in-process `HttpClient` / `Pacer` instances passed via context. Modules never share mutable in-process state across loops.

## Module roles

| Module | Role | State it owns | Daemon-loop participation |
| --- | --- | --- | --- |
| `buffer` | bun:sqlite storage for batches, cursors, receipts, metadata, quarantine, daemon-state. Single source of truth for "what was captured" and "what is on the wire". | `buffer.db` schema + all DDL + transaction wrappers (`markBatchDelivered`, `pruneBuffer`). | Used by all three loops. Capture writes batches/cursors/quarantine; drain reads pending batches + writes receipts; heartbeat writes `metadata.last_version_check_at`. |
| `config` | Loads/writes `config.toml` once at daemon start. Resolves nest base URL from `dev-mode` sentinel. Computes defaults (`50 GiB` soft-pause, `30 d` retention). | The in-memory `GatewayConfig` (immutable for process lifetime). | Read once at daemon bootstrap; never re-read mid-run. |
| `contract` | Wire-contract types and `validateRawRecordDTO`. Holds `SOURCE_VARIANTS` matrix and body-size constants (`2 MiB` compressed, `10 MiB` decompressed). | None (pure types + validator). | Validation runs in `HttpClient.uploadRawRecord` before every POST. |
| `http` | `HttpClient` class with four methods (`verifyKey`, `registerHostId`, `fetchWatermarks`, `uploadRawRecord`). Centralised status-to-error mapping in `dispatchSuccessOrThrow`. | Per-instance: `apiKey`, `hostId`, `endpoints`, `fetchFn`. | One client instance per daemon; consumed by drain (`uploadBatch`) and heartbeat (`fetchWatermarks` via `syncServerWatermarks`). |
| `polling` | Three loops (capture / drain / heartbeat) under `Promise.all`. Four sentinel readers/writers (auth, buffer-full, session-stopped, update-available). Source-poll dispatcher (worker thread or in-process fallback). | Sentinel files; per-loop in-memory cycle state passed only to callbacks. | Owns all daemon loops. |
| `redaction` | `applyRedaction` single-pass walk over 13 rule categories. `ALL_RULES` runs in declaration order (`crypto-keys` first, `keyword-secret` last). | None (pure regex). `PRESERVED_TOKENS` lives in `preserve.ts` as a CI audit gate. | Invoked inside each source's `collect` step in the capture worker before compression. |
| `uploader` | Drain orchestration. `drainBuffer` walks pending batches via cursor pagination, `uploadBatch` classifies errors into the four `UploadOutcome` kinds, `pacer` enforces three independent backoff signals. | The `Pacer` instance (per-daemon token buckets). | Drain loop only. |
| `upgrade` | `runAutoUpgrade` (non-brew, non-dev): version check → download asset → atomic `replaceBinary` → `exitProcess()`. `release-fetch` exposes the platform-asset matcher. | None. | Heartbeat loop only. Brew installs use the `UPDATE_AVAILABLE` sentinel instead of in-place replace. |
| `uninstall` | Per-platform sweep: detect which package manager owns the binary (`createSweep`), remove via that PM, clean shell rc files / Windows User PATH, then delete the direct binary. | None. | Not a daemon module — invoked only from `proxai-gateway uninstall`. |

## Coordination boundaries

- **Sentinels** are the only cross-loop signal. Capture writes `BUFFER_FULL`; drain clears it. Drain writes `AUTH_FAILED`; only `setup --force` clears it. See `ai/knowledge/services/sentinel-lifecycle.md` for the full table.
- **Buffer DB** is the only shared mutable state. All cross-loop visibility flows through SQL rows: cursors, batches, receipts, metadata counters, `daemon_state` singleton row.
- **HttpClient / Pacer** are constructed once at daemon bootstrap and threaded into both drain and heartbeat contexts. They are not shared with capture (capture never makes outbound HTTP).

## What lives in each per-module knowledge file

- `buffer.md` — schema layout, `WAL` open settings, the `markBatchDelivered` + `pruneBuffer` transactional pair, pressure measurement, quarantine semantics.
- `config.md` — per-platform `config.toml` location, `validateAndCoerce` field-by-field defaults, env-var override precedence (`PROXAI_GATEWAY_NEST_ENDPOINT`), why hot-reload is intentionally absent.
- `contract.md` — the `RawRecordDTO` shape, `SOURCE_VARIANTS` enumeration, `validateRawRecordDTO` invariants (UUIDv7, ISO-8601 with `Z`, base64 stride, watermark monotonicity).
- `http.md` — request lifecycle, the two timeout constants (`UPLOAD_TIMEOUT_MS = 60_000`, `DEFAULT_TIMEOUT_MS = 30_000`), the four endpoint methods, the eight HTTP-status → typed-error mappings.
- `polling.md` — `runDaemonLoops` shape, the three loop intervals, `capture-cycle` worker dispatch, `drain-cycle` prune/pressure handling, `heartbeat-cycle` stale-binary + version-check throttle.
- `redaction.md` — single-pass design, 13 categories in run order, `PRESERVED_TOKENS` audit gate, why `source_path` is intentionally never redacted.
- `uploader.md` — `drainBuffer` cursor walk + consecutive-retriable break, `uploadBatch` four-outcome classification, `Pacer` three backoff signals (`Retry-After`, 429, 5xx).
- `upgrade.md` — `runAutoUpgrade` flow, why brew goes through `UPDATE_AVAILABLE` sentinel, version-check throttle (`4 h` default), Windows `.exe.new` staging.
- `uninstall.md` — sweep order (PM detect → uninstall → shell-rc cleanup → direct binary removal), platform divergence (POSIX vs Windows `cmd.exe /c del` deferred), what is preserved (config + buffer + logs).

[source: src/services/{buffer,config,contract,http,polling,redaction,uploader,upgrade,uninstall}/index.ts; src/services/polling/daemon-loops.ts:26-41; src/services/polling/polling.constants.ts:5-9]
