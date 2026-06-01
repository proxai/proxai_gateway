# config

`src/services/config/` loads and validates `config.toml` once at daemon start. The result (`GatewayConfig`) is immutable for the process lifetime — there is no hot-reload by design.

## File location

Resolved by `configFilePath()` in `core/io/fs`. Per-platform layout:

| Platform | Config dir | Sentinel dir | Buffer dir | Log dir |
| --- | --- | --- | --- | --- |
| macOS | `~/Library/Application Support/proxai-gateway/config.toml` | same dir | `<configDir>/buffer.db` | `~/Library/Logs/proxai-gateway/` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/proxai-gateway/config.toml` | same dir | `<configDir>/buffer.db` | `${XDG_STATE_HOME:-~/.local/state}/proxai-gateway/` |
| Windows | `%APPDATA%\proxai-gateway\config.toml` | same dir | `<configDir>\buffer.db` | `%LOCALAPPDATA%\proxai-gateway\logs\` |

(Resolved via `core/io/fs`; canonical per-platform logic lives there, not in services/config.)

## Schema (TOML sections)

| Section | Fields | Notes |
| --- | --- | --- |
| `[account]` (required) | `api_key`, `user_id`, `host_id`, `installed_at`, `install_source` | All required, all non-empty. `install_source` ∈ `{bun, pnpm, yarn, npm, brew, github_release}`. |
| `[backend]` (optional) | `ingest_url`, `verify_key_url`, `watermarks_url`, `register_host_id_url` | Each falls back to a constant resolved from `NEST_BASE_URL` (dev sentinel → `http://localhost:3001`, else `https://proxainest-production.up.railway.app`). |
| `[capture]` (optional) | `poll_interval_sec`, `buffer_path`, `receipt_retention_days`, `failed_retention_days`, `buffer_soft_pause_bytes`, `buffer_soft_resume_bytes`, `upload_max_batches_per_sec`, `upload_max_bytes_per_minute`, `upload_backoff_on_429_multiplier`, `max_decompressed_bytes` | All optional; defaults from `config.constants.ts`. |
| `[logging]` (optional) | `level`, `log_dir` | `level` ∈ pino levels; default from `core/log`. |
| `[stale_binary]` (optional) | `warn_after_days`, `pause_after_days` | Defaults 30 / 60. |

## Defaults

Defaults live in `config.constants.ts`, **not** in a written-out template. `validateAndCoerce` fills omitted fields when reading. This means a freshly-written `config.toml` from `setup` includes every field, but a hand-edited one with a section omitted still works.

| Constant | Value | Notes |
| --- | --- | --- |
| `DEFAULT_POLL_INTERVAL_SEC` | `300` | Not actually used by the daemon — capture interval is the hardcoded `CAPTURE_INTERVAL_MS = 120_000` in polling. This field is for the legacy `poll` command. |
| `MIN_POLL_INTERVAL_SEC` / `MAX_POLL_INTERVAL_SEC` | `60` / `3600` | Range check only. |
| `DEFAULT_RECEIPT_RETENTION_DAYS` | `30` | |
| `DEFAULT_FAILED_RETENTION_DAYS` | `30` | |
| `DEFAULT_BUFFER_SOFT_PAUSE_BYTES` | `50 * 1024^3` (50 GiB) | Source memory said `700 MB`; that is wrong. |
| `DEFAULT_BUFFER_SOFT_RESUME_BYTES` | `45 * 1024^3` (45 GiB) | Hysteresis enforced: `resume < pause` or `ValidationError`. |
| `DEFAULT_UPLOAD_MAX_BATCHES_PER_SEC` | `5` | `MIN_UPLOAD_MAX_BATCHES_PER_SEC = 0.1`. |
| `DEFAULT_UPLOAD_MAX_BYTES_PER_MINUTE` | `50 * 1024^2` (50 MiB) | |
| `DEFAULT_UPLOAD_BACKOFF_ON_429_MULTIPLIER` | `2` | |
| `DEFAULT_STALE_WARN_DAYS` / `DEFAULT_STALE_PAUSE_DAYS` | `30` / `60` | |

## Validation flow

`loadConfigFromFile(path?)` → `Bun.file().text()` → `smol-toml.parse()` → `validateAndCoerce(raw)`.

- All errors throw `ValidationError` (CLI exit code `2`).
- Type-coercing helpers (`requireString`, `optionalNumber({min, max})`, `optionalPositiveNumberOrInfinity`, `parseInstallSource`, `parseLogLevel`) are private — every section's validator composes them.
- `max_decompressed_bytes` is the only field that accepts `+Infinity` (for tests that disable the size budget); the writer omits it from the TOML when infinite.
- Cross-field check: `buffer_soft_resume_bytes >= buffer_soft_pause_bytes` is a hard reject.

## Writing

`writeConfigToFile(config, path?)` calls `serializeConfig` (`stringifyToml`), then `writeAtomic` (temp + rename), then `setMode(path, 0o600)`. The mode call is silently skipped on Windows by `setMode` itself (see `core/io/fs/mode.ts`).

## Env-var override

`PROXAI_GATEWAY_NEST_ENDPOINT` is read at module load by `core/io/fs` (the dev-mode sentinel detection) and influences `NEST_BASE_URL`. **Once `setup` has written `[backend]` to `config.toml`, the env-var has no effect** — the resolved URLs are persisted. To change a running install's backend you must edit `[backend]` or re-run `setup new`.

## Hot-reload behavior

There is none. The daemon reads config once at start; SIGHUP does not re-read. This is intentional — config changes during a cycle would create dangerous mid-flight inconsistencies (think: cursor table changing while capture is mid-walk). To apply a config change, restart the daemon (`proxai-gateway service restart` or platform equivalent).

## `install_source` inference

`inferInstallSource(execPath, platform?)` (in `install-source-infer.ts`) normalizes the exec path and matches against substrings: `/.proxai/bin/` → `github_release`, `/cellar/` or `/linuxbrew/` → `brew`, `/.bun/install/global/` → `bun`, `/pnpm/` → `pnpm`, `/.yarn/` → `yarn`, `node_modules/@proxai/` → `npm`. Default fallback is `github_release`. The inference is invoked once at `setup` time, then persisted to `config.toml`; it is never re-inferred at daemon runtime (`install_source` drives auto-upgrade branch + uninstall sweep).

## `sub-agent-flags`

`PROXAI_GATEWAY_CAPTURE_SUB_AGENTS` (global) and four per-source variants (`_CLAUDE_CODE`, `_CODEX`, `_CURSOR`, `_GEMINI_CLI`) are read **at module load** into a frozen `SUB_AGENT_CAPTURE_BY_SOURCE` record. A daemon restart is required to flip them. These flags are maintainer-only and intentionally absent from `--help` / `config.toml` / README.

[source: src/services/config/config.constants.ts:1-48; src/services/config/config.types.ts:1-49; src/services/config/loader.ts:8-26; src/services/config/validate.ts:35-267; src/services/config/writer.ts:6-52; src/services/config/install-source-infer.ts:5-17; src/services/config/sub-agent-flags.ts:1-32]
