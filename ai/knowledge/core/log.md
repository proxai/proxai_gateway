# Core Log

`src/core/log/` wraps pino with a small daemon-friendly surface: one factory (`createLogger`), one pruner (`pruneLogDirectory`), and a fixed file-name convention. Every log event in the running daemon flows through this module — there is no `console.log` in `src/services/` or `src/sources/`.

## `createLogger(options)`

`logger.ts:19` returns a `pino.Logger`. The factory has four mutually exclusive sink modes, chosen in this priority order:

| Branch | Trigger | Where logs go |
| --- | --- | --- |
| Explicit `destination` | `options.destination !== undefined` | wherever the caller hands us (tests inject in-memory streams) |
| Rolling log file | `options.logDir !== undefined` | pino-roll daily-rolled file under `logDir` |
| Pretty stdout | `options.pretty === true` | colorized stdout via `pino-pretty` |
| Default | (none of the above) | `pino.destination(1)` raw ndjson to stdout |

The daemon (`runDaemon`) takes the second branch with `level = config.logging.level`, `logDir = config.logging.logDir`, and `bindings = { service: 'proxai-gateway', version, host_id }` so every line is host-tagged. The CLI's `tail` command does not use `createLogger` — it reads the rotated files directly.

## File-name convention

Constants in `log.constants.ts:5`:

- `STRUCTURED_LOG_FILENAME = 'structured.log'` — used only by `defaultLogFilePath()` for diagnostics.
- `STRUCTURED_LOG_BASENAME = 'structured'`, `STRUCTURED_LOG_EXTENSION = '.log'`, `STRUCTURED_LOG_DATE_FORMAT = 'yyyy-MM-dd'` — fed to pino-roll.

The active file is `structured.<YYYY-MM-DD>.<N>.log` where `<N>` is the within-day sequence (always `1` unless the process forcibly rotates mid-day, which we do not do). `tail` resolves "today's path" by re-reading `today` on every poll so midnight rollover is picked up.

## Per-platform log paths

`logDir()` (`core/io/fs/paths.ts:22`):

| Platform | Path |
| --- | --- |
| `darwin` | `~/Library/Logs/proxai/proxai-gateway` |
| `linux` | `~/.local/state/proxai/proxai-gateway/log` |
| `win32` | `%LOCALAPPDATA%\proxai\proxai-gateway\Logs` |

The user can override via `config.toml`'s `[logging] log_dir = "..."`. `expandHome` resolves `~`-prefixed entries.

## Rotation and retention

| Setting | Value | Source |
| --- | --- | --- |
| Frequency | daily | `createLogger`: `frequency: 'daily'` |
| Retention | 90 days | `LOG_RETENTION_DAYS = 90` |
| Total cap | 5 GiB | `LOG_TOTAL_SIZE_CAP_BYTES = 5 * 1024 ** 3` |
| Sync | yes | `sync: true` — every write hits disk; no buffering |
| Mkdir | yes | pino-roll auto-creates the dir |
| File mode | `0o600` POSIX; default ACL Windows | `secureLogStream` chmods on open and on `ready` event |

Pino-roll's own `limit: { count: LOG_RETENTION_DAYS }` enforces the day cap inside the rolling stream. The `pruneLogDirectory` helper handles the second cap (total bytes) and is called once at daemon start (`runDaemon`: `await pruneLogDirectory(logDir)`).

### `pruneLogDirectory`

`prune.ts:24` runs two passes over `logDir`:

1. **Day-count pass.** While `files.length > retentionDays`, delete the oldest. Files are sorted by date (extracted from the filename via `FILE_MATCH_PATTERN`).
2. **Byte-cap pass.** While `totalSize > sizeCap` and at least one file remains, delete the oldest and decrement `totalSize`.

After both passes, survivors are re-chmodded to `0o600` (`setMode` is a no-op on Windows). The function returns `{ deletedFiles, retainedBytes, retainedCount }`. Files whose names don't match `^structured\.\d{4}-\d{2}-\d{2}\.\d+\.log$` are ignored — `tail` artifacts, pid files, or user droppings are preserved.

## Levels

`LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace'`. `DEFAULT_LOG_LEVEL = 'info'`. `VALID_LOG_LEVELS` is exported as a readonly tuple for CLI flag validation (`tail --level <level>`).

Pino's level numbering is the standard 10/20/30/40/50/60. Setting `level = 'warn'` discards `info`/`debug`/`trace` at write time, so they do not enter the rolling file.

## Bindings

`bindings: { service, version, host_id }` is set once at `createLogger` and applied to every record. Per-call bindings (e.g. `logger.info({ source_app: 'cursor', ... }, 'message')`) layer on top. The `event` field is the conventional discriminator the daemon uses for downstream filtering (`capture.cycle.complete`, `drain.complete`, `upload.fatal`, etc. — see `ai/knowledge/services/observability-events.md`).

## What we don't do

- No log to syslog / Event Log. Only the daily-rolled ndjson file.
- No remote shipping. Logs stay on disk; the user opts in to upload via `support bundle` (not yet implemented in this slice).
- No structured log rotation by size during the day. The byte cap is enforced lazily by `pruneLogDirectory` at daemon start, not mid-day.

[source: src/core/log/logger.ts:19,27,54,63,74; src/core/log/log.constants.ts:3,5,10,13; src/core/log/log.types.ts:3,7,15; src/core/log/prune.ts:13,24,53,62; src/core/io/fs/paths.ts:22; src/cli/commands/run/index.ts:32,45]
