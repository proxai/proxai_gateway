# Configuration reference

Every field the gateway reads from `~/.proxai/config.toml`, with type, default,
and the runtime semantic it controls. The TOML section names match the layout
in the file; the TS column names match the parsed `GatewayConfig` shape from
`services/config/config.types.ts`. Defaults shown are what
`proxai-gateway setup` writes; the validator in
`services/config/validate.ts` accepts a wider range and only fails when a value
falls outside the documented range.

## File location and permissions

| Platform | Path |
|---|---|
| macOS, Linux | `~/.proxai/config.toml` |
| Windows | `%LOCALAPPDATA%\proxai-gateway\config.toml` |

Mode is set to `0600` on POSIX during `setup` (the file contains the ingestion
key). The file is parsed with `smol-toml`; comments and trailing newlines are
preserved by `writeConfigToFile`.

The path can be overridden per-invocation via `--config <path>` on the daemon,
status, tail, and backfill commands.

## `[account]` — required

| TOML key | TS field | Type | Required | Semantics |
|---|---|---|---|---|
| `api_key` | `account.apiKey` | string (non-empty) | yes | The ingestion-type API key. Sent as `X-API-Key` on every request. Format: `<random>-<datestr>-<random>` (three hyphen-separated parts, validated at setup time). |
| `user_id` | `account.userId` | string (non-empty) | yes | The ProxAI account user id. Read from the `verify-key` response at setup; baked into `host_id`. |
| `host_id` | `account.hostId` | string (non-empty) | yes | `sha256(machineUuid + ':' + userId)`, lowercase hex. Stable across reinstalls on the same machine and user. Sent as `host_id` in every DTO. |
| `installed_at` | `account.installedAt` | ISO-8601 UTC string | yes | When this binary was first set up. Drives the stale-binary check. |
| `install_source` | `account.installSource` | enum | yes | One of `bun \| pnpm \| yarn \| npm \| brew \| github_release`. Telemetry only. Defaults to `github_release` if `setup` is run without `--install-source`. |

`account.api_key` is the only secret in the file; treat the file accordingly.

## `[backend]` — optional, defaults to production

| TOML key | TS field | Type | Default | Semantics |
|---|---|---|---|---|
| `ingest_url` | `backend.ingestUrl` | string | `https://proxainest-production.up.railway.app/v1/raw_records` | `POST` endpoint for batch uploads. |
| `verify_key_url` | `backend.verifyKeyUrl` | string | `https://proxainest-production.up.railway.app/ingestion/verify-key` | `GET` endpoint for ingestion-key verification. Hit at `setup`, and reactively after a 401/403 from the ingest endpoint. |
| `watermarks_url` | `backend.watermarksUrl` | string | `https://proxainest-production.up.railway.app/v1/watermarks` | `GET` endpoint for the per-host watermark sync used on first daemon start after a fresh install. |

The whole table can be omitted; the defaults above apply. The defaults are
also influenced by environment variables at process start: `PROXAI_NEST_URL`
overrides the base, and `NODE_ENV=development` selects `http://localhost:3001`
as the base when no override is set.

## `[capture]` — operational knobs

| TOML key | TS field | Type | Default | Range | Semantics |
|---|---|---|---|---|---|
| `poll_interval_sec` | `capture.pollIntervalSec` | number | `300` | `60` to `3600` | Seconds between poll cycles. The validator clamps to `[60, 3600]`. |
| `buffer_path` | `capture.bufferPath` | string | `~/.proxai/buffer.db` (POSIX) / `%LOCALAPPDATA%\proxai-gateway\buffer.db` (Windows) | absolute path | SQLite database file. Created if missing; opened in WAL mode with `synchronous = NORMAL`. `~` is expanded. |
| `receipt_retention_days` | `capture.receiptRetentionDays` | number | `30` | `>= 0` | How long delivered-batch receipts are kept in `upload_receipts` for cross-restart idempotency. Pruned at the end of every poll cycle. |
| `failed_retention_days` | `capture.failedRetentionDays` | number | `30` | `>= 0` | How long fatally-failed batches are kept in `upload_batches` (status `failed`) for diagnostics. Pruned at the end of every poll cycle. |
| `buffer_soft_pause_bytes` | `capture.bufferSoftPauseBytes` | number | `734003200` (700 MiB) | `>= 1` | When `pending_bytes` exceeds this threshold, the cycle writes the `BUFFER_FULL` sentinel and subsequent cycles short-circuit until pending drops below the resume threshold. |
| `buffer_soft_resume_bytes` | `capture.bufferSoftResumeBytes` | number | `629145600` (600 MiB) | `>= 0`; must be `< buffer_soft_pause_bytes` | When `pending_bytes` falls below this threshold (and the sentinel is set), the sentinel is cleared. The 100 MiB hysteresis prevents flapping. |
| `initial_scan_window_days` | `capture.initialScanWindowDays` | number | `30` | `>= 0` | Discovery cap for fresh installs (no cursors yet for that source app). Files older than `now - N days` are skipped on first contact. Once any cursor exists for that source app, the cap is ignored — the cursor itself is the lower bound. |
| `upload_max_batches_per_sec` | `capture.uploadMaxBatchesPerSec` | number | `5` | `> 0` | Pacer's batches-per-second token-bucket capacity. |
| `upload_max_bytes_per_minute` | `capture.uploadMaxBytesPerMinute` | number | `52428800` (50 MiB) | `>= 1` | Pacer's bytes-per-minute token-bucket capacity. Each batch debits `min(bodyBytes, capacity)` from this bucket. |
| `upload_backoff_on_429_multiplier` | `capture.uploadBackoffOn429Multiplier` | number | `2` | `>= 1` | Multiplicative factor applied to consecutive 429 backoffs. Backoff = `slot_ms * (multiplier^streak - 1)`, capped at 30 s. Streak resets on the first non-429 response. |

Notes on validation:
- `buffer_soft_resume_bytes` strictly less than `buffer_soft_pause_bytes` is
  enforced at load time; an inverted pair is a startup error.
- `initial_scan_window_days = 0` disables the cap entirely (every discovered
  file ships, regardless of mtime).

## `[logging]` — observability

| TOML key | TS field | Type | Default | Range | Semantics |
|---|---|---|---|---|---|
| `level` | `logging.level` | enum | `trace` | `fatal \| error \| warn \| info \| debug \| trace` | Pino log level. The level written by `setup` is `info`; the validator default is `trace`. The CLI `tail --level` filter is independent of this value (filters at read time). |
| `log_dir` | `logging.logDir` | string | macOS: `~/Library/Logs/proxai-gateway`; Linux: `~/.local/state/proxai-gateway/log`; Windows: `%LOCALAPPDATA%\proxai-gateway\Logs` | absolute path | Directory holding daily-rotated structured-log files (`structured.YYYY-MM-DD.1.log`, NDJSON). Files are chmod'd to `0600` on POSIX after each rotation. Retention is 90 days, capped by file count, applied by pino-roll's `limit.count` and the `pruneLogDirectory` startup pass. |

## `[stale_binary]` — freshness policy

| TOML key | TS field | Type | Default | Range | Semantics |
|---|---|---|---|---|---|
| `warn_after_days` | `staleBinary.warnAfterDays` | number | `30` | `>= 0` | Days since `installed_at` before each cycle emits a `stale_binary.warning` log entry. `0` disables warnings. |
| `pause_after_days` | `staleBinary.pauseAfterDays` | number | `60` | `>= 0` | Days since `installed_at` before the cycle writes the `PAUSED` sentinel with reason `stale_binary: ...`. `0` disables auto-pause. |

When the daemon pauses on stale-binary, the only ways out are
`proxai-gateway resume` (which clears the sentinel until the next cycle
re-evaluates) or `proxai-gateway setup` with a newer binary (which refreshes
`installed_at`).

## Example config (defaults shown explicitly)

```toml
[account]
api_key = "abc-20260101-def"
user_id = "u_abc"
host_id = "8a3aed6b9c1f..."
installed_at = "2026-04-29T10:42:00.123Z"
install_source = "github_release"

[backend]
ingest_url = "https://proxainest-production.up.railway.app/v1/raw_records"
verify_key_url = "https://proxainest-production.up.railway.app/ingestion/verify-key"
watermarks_url = "https://proxainest-production.up.railway.app/v1/watermarks"

[capture]
poll_interval_sec = 300
buffer_path = "/Users/me/.proxai/buffer.db"
receipt_retention_days = 30
failed_retention_days = 30
buffer_soft_pause_bytes = 734003200
buffer_soft_resume_bytes = 629145600
initial_scan_window_days = 30
upload_max_batches_per_sec = 5
upload_max_bytes_per_minute = 52428800
upload_backoff_on_429_multiplier = 2

[logging]
level = "info"
log_dir = "/Users/me/Library/Logs/proxai-gateway"

[stale_binary]
warn_after_days = 30
pause_after_days = 60
```

## Environment overrides

A small set of values can be influenced from the environment without editing
the config file. These are read at process start and only affect the
defaults that `setup` writes or that an absent `[backend]` table leaves
unset.

| Variable | Effect |
|---|---|
| `PROXAI_NEST_URL` | Overrides the nest base URL for all three endpoints. Trailing slash is stripped. Useful for staging or on-prem. |
| `NODE_ENV=development` | When `PROXAI_NEST_URL` is unset, selects `http://localhost:3001` as the nest base. |

There is no environment override for the ingestion key, the host_id, or the
buffer path — those live in the config file or are derived from machine state.
