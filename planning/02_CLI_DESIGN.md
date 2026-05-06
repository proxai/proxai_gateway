# CLI Design — `proxai-gateway`

> **DEPRECATED** as of 2026-05-06.
> This doc captured the planned CLI surface as of early 2026-04; the shipped
> command surface is substantially different. See the project `README.md` for
> the current authoritative surface, and `src/cli/commands/` for the
> implementation.
>
> Specific items now stale:
> - **Commands renamed / removed.** `install` → `setup`. `uninstall` removed (the
>   policy is now: stop the service, remove the platform unit by hand, optionally
>   delete `~/.proxai/`; documented in `README.md` "How do I uninstall?").
>   `doctor` is not implemented. `run` is hidden (still the daemon entry, invoked
>   by the platform service unit).
> - **New commands shipped:** `start`, `stop`, `restart` (thin wrappers over
>   launchctl / systemctl --user / schtasks), `backfill --since <Nd|Nmo|Ny>` for
>   history older than the default 30-day initial-scan window, `tail` with
>   `--lines / --follow / --source / --level / --since / --json` flags,
>   `redaction list [--categories|--category <name>|--json]` and
>   `redaction test <file> [--show-rules]`.
> - **Auth flow:** `setup` calls `GET /ingestion/verify-key` (per
>   `nest-contract.md` §2.1), not the obsolete `POST /v1/auth/validate`. The
>   gateway uses `X-API-Key` headers, not `Authorization: Bearer`.
> - **`host_id` is deterministic** (`sha256(machine_uuid + ':' + user_id)`),
>   not a UUIDv7 minted at install. See `nest-contract.md` §5.4. The
>   `[account].machine_id` field shown in §4 is now `[account].hostId` /
>   `[account].userId`.
> - **`bufferMaxBytes` is gone.** Replaced with `bufferSoftPauseBytes` /
>   `bufferSoftResumeBytes` (default 700 MB / 600 MB hysteresis) and
>   `receiptRetentionDays` / `failedRetentionDays` retention controls. See
>   `src/services/config/config.types.ts`.
> - **No `pause` / `resume` JSON-RPC over a Unix socket.** `pause` / `resume`
>   simply touch / remove `~/.proxai/PAUSED`. `status` reads the buffer DB
>   directly. `tail` reads the rotated log files directly via pino-roll output.
>   No `~/.proxai/control.sock`.
> - **Service-manager entry** is launchd on macOS, systemd user unit on Linux,
>   per-user scheduled task on Windows — all shipped from day one (Linux and
>   Windows are not Phase 2 / Phase 3).
> - **No FDA probe / `--accept-warnings` flow.** `setup` is non-interactive when
>   `--api-key` is passed; otherwise it prompts for the key (and double-prompts
>   on overwrite).
> - **Exit codes** in §8 are not the codes the implementation returns.
>   Authoritative list is `src/cli/cli.constants.ts` (`EXIT_CODE`).
>
> Kept for archaeological value: the goals (one-command setup, idempotency, a
> status command that answers "is this thing working?"), the tone of the install
> consent flow, and the spirit of "don't lecture, three-line errors" — those
> survived. The literal command surface did not.

---

## 1. Goals & non-goals

**Goals**
- One-command first-time setup (account + auth + launchd registration).
- Three control verbs: `pause`/`resume` (soft), `start`/`stop` (hard), `install`/`uninstall` (full).
- A `status` command that's the answer to "is this thing working?"
- A `doctor` command for support tickets.
- Idempotency: every command can be re-run safely.

**Non-goals**
- Configuration UI (config is a TOML file edited via CLI flags or by hand).
- Per-source enablement at the CLI (sources are bundled in the binary for MVP).
- Multi-account support (one API key per machine; switch by re-running `install`).

---

## 2. Prerequisites — account & API key

Before running any setup command, the user needs:

1. **A proxai.co account.** Sign up at <https://proxai.co/signup> if they don't have one. (Existing customers of the `proxai` library already have accounts.)
2. **An API key.** Any key from their proxai.co dashboard works — an existing SDK key, a dedicated gateway key, doesn't matter. ProxAI's API-key infrastructure already supports multiple keys per user (e.g., separate keys for colab / local / production SDK use); this CLI uses the same system.

The user is identified by the key. Per-device attribution comes from a `machine_id` (UUIDv7) generated at install time and included in every upload — independent of which key was used. So a user reusing one key across two laptops still gets clean per-device telemetry.

CLI uploads land on `/v1/raw_records`; SDK calls land on the existing generate / messages / etc. endpoints. The backend distinguishes traffic types by endpoint, not by key flavor.

---

## 3. Command reference

### 3.1 `proxai-gateway install`

**Intent.** First-time setup on a machine. Does account auth, FDA probe, launchd registration, smoke-test upload, prints next-step instructions. Idempotent — re-running on an already-installed machine reconciles state (re-validates key, regenerates plist, etc.).

**Synopsis**
```
proxai-gateway install [--api-key <key>] [--non-interactive] [--ingest-url <url>] [--skip-fda-probe] [--accept-warnings]
```

**Parameters**

| Flag | Description | Default |
|---|---|---|
| `--api-key <key>` | proxai.co gateway API key. Skips interactive prompt. | — (interactive prompt) |
| `--non-interactive` | Fail immediately if any prompt would be needed (consent, key entry, FDA grant). For CI / MDM. | false |
| `--ingest-url <url>` | Override default backend ingest URL. Phase 3 (self-hosted backend). | `https://nest.proxai.co/v1/raw_records` |
| `--skip-fda-probe` | Skip the Full Disk Access probe. Use when you know you'll grant it later. | false |
| `--accept-warnings` | Continue install even if FDA isn't granted or smoke-test fails. Surfaces warnings instead of erroring. | false |

**Flow**

1. **Detect existing install.** If `~/.proxai/config.toml` exists and launchd unit is loaded, print "already installed; re-running reconciles state" and continue.
2. **Show consent screen.** Lists exactly which directories will be read, what redaction does, where data goes, link to OSS source. Requires `[Yes, install]` confirmation. Bypassed only by `--non-interactive` if `~/.proxai/CONSENT_ACCEPTED` already exists from a prior install.
3. **Get API key.** Use `--api-key`, else interactive prompt with link to dashboard.
4. **Validate API key against backend.** `POST /v1/auth/validate` with the key. Backend returns `{valid: bool, account_email, error?}` or an error. The CLI generates `machine_id` (UUIDv7) locally and includes it on every upload — backend doesn't need to mint it. On invalid key: print clear message + dashboard link, retry up to 3 times, then exit 2.
5. **Probe Full Disk Access.** Try reading `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`. On `EPERM`/`EACCES`: print FDA grant instructions including the System Settings deeplink (`x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles`). With `--accept-warnings`: continue and surface a warning. Without: exit 3.
6. **Initialize state directory.** Create `~/.proxai/` (mode 0700), write `config.toml`, initialize `~/.proxai/buffer.db` (SQLite WAL).
7. **Generate launchd plist.** Render template into `~/Library/LaunchAgents/co.proxai.gateway.plist`. Substitute the absolute path of the `proxai-gateway` binary itself (resolved via `realpath` of `argv[0]`, which `bun build --compile` sets correctly). The shipped artifact is a single self-contained executable — there is no separate runtime to invoke. launchd has a minimal `PATH`, so the plist must carry an absolute path.
8. **Bootstrap launchd.** `launchctl bootstrap gui/$(id -u) <plist>`. Verify with `launchctl print gui/$(id -u)/co.proxai.gateway`.
9. **Smoke-test upload.** Send a synthetic test record to the ingest endpoint. Backend acks. With `--accept-warnings`: warn and continue if smoke fails (transient network).
10. **Print summary.** Where logs are, how to view status, how to pause, how to uninstall.

**Exit codes**
- `0` — success
- `1` — generic / unknown
- `2` — invalid API key
- `3` — FDA not granted (without `--accept-warnings`)
- `4` — launchd registration failed
- `5` — smoke-test upload failed (without `--accept-warnings`)
- `6` — `--non-interactive` set but a prompt was required

**Side effects after success**
- `~/.proxai/` directory created, mode 0700
- `~/.proxai/config.toml` written
- `~/.proxai/buffer.db` initialized
- `~/.proxai/CONSENT_ACCEPTED` written (timestamp + version)
- `~/Library/LaunchAgents/co.proxai.gateway.plist` written
- launchd unit loaded and running
- One synthetic record visible on the backend dashboard

---

### 3.2 `proxai-gateway uninstall`

**Intent.** Reverse `install` cleanly. Defaults to keeping the buffer DB and config for diagnostic purposes; `--purge` removes everything.

**Synopsis**
```
proxai-gateway uninstall [--purge] [--non-interactive]
```

**Parameters**

| Flag | Description | Default |
|---|---|---|
| `--purge` | Also remove `~/.proxai/` (config, buffer, captures log). | false |
| `--non-interactive` | Skip the "are you sure?" prompt. | false |

**Flow**

1. **Confirm.** Interactive prompt unless `--non-interactive`.
2. **Bootout launchd.** `launchctl bootout gui/$(id -u)/co.proxai.gateway`.
3. **Remove plist.** Delete `~/Library/LaunchAgents/co.proxai.gateway.plist`.
4. **Optionally purge.** If `--purge`: remove `~/.proxai/`. Otherwise leave it for re-install.
5. **Print summary.** Note that the package is removed with the package-manager command that matches the install path — `bun rm -g @proxai/gateway`, `pnpm rm -g @proxai/gateway`, `yarn global remove @proxai/gateway`, `npm uninstall -g @proxai/gateway`, or `brew uninstall proxai/tap/proxai-gateway`. The installer records which one was used and prints the matching command.

**Exit codes**: 0 success; 1 generic; 4 launchd unload failed.

---

### 3.3 `proxai-gateway status`

**Intent.** "Is this thing working?" The answer fits on one screen.

**Synopsis**
```
proxai-gateway status [--json] [--watch [<seconds>]]
```

**Parameters**

| Flag | Description | Default |
|---|---|---|
| `--json` | Machine-readable output for scripts / dashboards. | false |
| `--watch [<seconds>]` | Refresh every N seconds (default 5) until interrupted. | off |

**Default output (human-readable)**

```
ProxAI Gateway 0.4.2 — Active

Last upload:        2 min ago (47 records)
Captures pending:   3
Captures today:     312
Backend:            reachable (nest.proxai.co)

Sources:
  claude-code   ✓ active   12 sessions tracked, last activity 4 min ago
  cursor        ✓ active   2 workspaces tracked, last activity 17 min ago
  codex         ✓ active   1 session tracked, last activity 1 min ago

Health:
  Full Disk Access:   granted
  Buffer:             3 pending / 500 MB cap (0.1% used)
  Binary age:         12 days (next stale warning in 78 days)
  Redaction self-test: passing (last run 4 min ago)
```

**JSON output (`--json`)**: structured equivalent. Fields stable across versions; new fields added but never removed without a major bump.

**Exit codes**
- `0` — Active
- `1` — generic / unable to query daemon
- `10` — Paused (sentinel present)
- `11` — Stopped (launchd unit not loaded)
- `12` — Active but degraded (e.g., FDA missing, backend unreachable, redaction self-test failing)

The exit codes let monitoring scripts react to specific states.

---

### 3.4 `proxai-gateway pause` / `proxai-gateway resume`

**Intent.** Soft-stop without unloading the daemon. The daemon process keeps running but skips reads, redaction, and uploads.

**Mechanism.** Touches `~/.proxai/PAUSED` (with timestamp + reason) for `pause`; removes it for `resume`. Daemon checks at the top of each poll cycle.

**Synopsis**
```
proxai-gateway pause [--reason <text>]
proxai-gateway resume
```

**Parameters**

| Flag | Description | Default |
|---|---|---|
| `--reason <text>` | Free-text reason recorded in the sentinel for later forensics. | "" |

**Side effects**
- `pause`: writes `~/.proxai/PAUSED` containing `{paused_at: ISO8601, reason: text}`.
- `resume`: removes `~/.proxai/PAUSED`.

**Exit codes**: 0 success; 1 generic; 13 already in target state.

---

### 3.5 `proxai-gateway start` / `proxai-gateway stop`

**Intent.** Hard control of the daemon process itself. Use only when something is genuinely wrong with the running daemon. For everyday "stop capturing for an hour", use `pause`.

**Mechanism**
- `start`: `launchctl bootstrap` if not loaded, then `launchctl kickstart`.
- `stop`: `launchctl bootout`. The daemon stays stopped until the next `start` or until next user login (because the plist's `RunAtLoad=true` will restart it then).

**Synopsis**
```
proxai-gateway start
proxai-gateway stop
```

**No parameters.**

**Exit codes**: 0 success; 1 generic; 4 launchd command failed; 13 already in target state.

---

### 3.6 `proxai-gateway tail`

**Intent.** Show recent structured-log entries. Equivalent to `tail [-f]` on the JSON log files but with filtering.

**Synopsis**
```
proxai-gateway tail [--lines <n>] [--follow] [--source <name>] [--level <level>] [--since <duration>]
```

**Parameters**

| Flag | Description | Default |
|---|---|---|
| `--lines <n>` | Number of lines to show. | 50 |
| `--follow`, `-f` | Stream new entries until interrupted. | false |
| `--source <name>` | Filter to one collector (`claude-code`, `cursor`, `codex`). | all |
| `--level <level>` | Minimum level: `debug`, `info`, `warn`, `error`. | `info` |
| `--since <duration>` | Limit to entries after now-duration (e.g., `1h`, `24h`). | none |

**Source.** Reads `~/Library/Logs/proxai-gateway/structured.log`. Pretty-prints each line.

---

### 3.7 `proxai-gateway redaction-test <file>`

**Intent.** Run the redaction pipeline against an arbitrary file and show what would be redacted. For QA, customer trust ("I don't believe you actually redact things"), and CI assertions on test fixtures.

**Synopsis**
```
proxai-gateway redaction-test <file> [--show-rules] [--rules <path>]
```

**Parameters**

| Flag | Description | Default |
|---|---|---|
| `<file>` | Positional, required. The file to test. | — |
| `--show-rules` | Print which rules matched and where. | false |
| `--rules <path>` | Override rule set (testing custom rules before they ship). | bundled |

**Output**: redacted file content to stdout. With `--show-rules`: a sidebar showing rule ID, line, span, replacement.

**Exit codes**
- `0` — file read successfully (whether or not anything matched)
- `1` — generic
- `7` — file unreadable

This command does **not** write anything anywhere. It's pure inspection.

---

### 3.8 `proxai-gateway doctor`

**Intent.** Diagnostic dump. Run before opening a support ticket. Output is safe to share — no captured data, no API key, no source bytes. Just system state.

**Synopsis**
```
proxai-gateway doctor [--json] [--include-logs]
```

**Parameters**

| Flag | Description | Default |
|---|---|---|
| `--json` | Machine-readable. | false |
| `--include-logs` | Append last 200 log lines (redacted; reviewed before printing). | false |

**Checks performed**

- Binary version, install date, days-since-update
- Embedded Bun runtime version (the version that was bundled into the binary at build time — informational only; users do not have a separately installed Bun)
- OS + version, architecture (arm64/x86_64), under Rosetta? (macOS) / glibc vs musl (Linux) / build (Windows)
- launchd unit state (`launchctl print`)
- Config file present and readable, `~/.proxai/` permissions correct (0700)
- Buffer DB integrity (`PRAGMA integrity_check`)
- For each source: path exists, FDA grant status (probe + result), last cursor value, last successful read
- Backend reachability: DNS, TCP, TLS, `GET /v1/health`
- API key state: present in config, last validated, last rejected
- Redaction: rule-set version, last self-test result + timestamp
- Disk: free space at `~/.proxai/`, current buffer size

**Exit codes**: 0 if all checks pass; 12 if any degraded; 1 generic.

---

### 3.9 `proxai-gateway version`

```
proxai-gateway version           # short: 0.4.2
proxai-gateway version --full    # JSON: version, build_date, embedded_bun_version, platform, arch, redaction_rules_version, schema_compat, install_source (bun|pnpm|yarn|npm|brew|github_release)
```

---

### 3.10 `proxai-gateway run` (internal)

**Intent.** The daemon entry point. **Not user-facing.** Invoked by launchd via `ProgramArguments`.

**Synopsis**
```
proxai-gateway run [--once] [--config <path>] [--log-level <level>]
```

**Parameters**

| Flag | Description | Default |
|---|---|---|
| `--once` | Run a single poll cycle and exit. For testing, not for ops. | false |
| `--config <path>` | Override config path. | `~/.proxai/config.toml` |
| `--log-level <level>` | Override log level (`debug`/`info`/`warn`/`error`). | from config |

**Behavior.** Loads config, connects to buffer DB, starts the polling loop, handles SIGTERM/SIGINT gracefully (drain in-flight uploads up to 10 seconds, then exit). Errors that crash the loop exit with code 1; launchd's `KeepAlive` restarts after `ThrottleInterval=30`.

---

## 4. Configuration file

`~/.proxai/config.toml`. Created by `install`. Editable by hand for advanced cases; `install --reconcile` (alias for re-running `install`) regenerates it from prompts/flags.

```toml
[account]
api_key = "pxg_live_..."     # gateway API key from proxai.co dashboard
machine_id = "01HZ..."        # UUIDv7 assigned at install time
installed_at = "2026-04-28T22:30:00Z"

[backend]
ingest_url = "https://nest.proxai.co/v1/raw_records"
auth_validate_url = "https://nest.proxai.co/v1/auth/validate"
health_url = "https://nest.proxai.co/v1/health"

[capture]
poll_interval_sec = 300       # 5 min default; min 60, max 3600
buffer_path = "~/.proxai/buffer.db"
buffer_max_bytes = 524288000  # 500 MB soft cap

[logging]
level = "info"                # debug | info | warn | error
log_dir = "~/Library/Logs/proxai-gateway"

[stale_binary]
warn_after_days = 90
pause_after_days = 180
```

The `[capture]` and `[stale_binary]` defaults are bundled in the binary; the config file makes them overridable for the rare ops case (e.g., a customer wants poll cadence at 60 seconds for a debugging session).

API key is stored at mode 0600 inside a 0700 directory. **Not** in macOS Keychain in MVP (Keychain access is its own pile of surprises; defer to Phase 2).

---

## 5. State files & paths

| Path | Owner | Purpose |
|---|---|---|
| `~/.proxai/config.toml` | install | Runtime config |
| `~/.proxai/buffer.db` | run | SQLite WAL buffer for pending uploads |
| `~/.proxai/buffer.db-wal`, `-shm` | sqlite | WAL sidecars |
| `~/.proxai/source_cursors.json` | run | Per-source byte-offset / rowid cursors |
| `~/.proxai/CONSENT_ACCEPTED` | install | Marker; presence bypasses re-consent on `install --reconcile` |
| `~/.proxai/PAUSED` | pause | Sentinel; presence pauses the daemon |
| `~/Library/LaunchAgents/co.proxai.gateway.plist` | install | launchd registration |
| `~/Library/Logs/proxai-gateway/structured.log` | run | Structured JSON logs |
| `~/Library/Logs/proxai-gateway/stdout.log`, `stderr.log` | launchd | Captured stdout/stderr |

Permissions: `~/.proxai/` is mode 0700; everything inside is mode 0600 unless otherwise noted. Logs are 0644 (Console.app needs to read them).

---

## 6. Common workflows

**First-time setup**
```sh
# pick whichever package manager you already use
bun add -g @proxai/gateway              # Bun
# or: pnpm add -g @proxai/gateway
# or: yarn global add @proxai/gateway
# or: npm install -g @proxai/gateway
# or: brew install proxai/tap/proxai-gateway

proxai-gateway install
# (paste API key, accept consent, grant FDA if prompted)
proxai-gateway status
```

**Update (MVP — manual)**
```sh
# match the package manager you installed with
bun add -g @proxai/gateway@latest        # Bun
# or: pnpm add -g @proxai/gateway@latest
# or: yarn global add @proxai/gateway@latest
# or: npm install -g @proxai/gateway@latest
# or: brew upgrade proxai/tap/proxai-gateway

proxai-gateway start   # forces a relaunch under the new binary
```

**Pause for a meeting**
```
proxai-gateway pause --reason "client demo"
# ... meeting ...
proxai-gateway resume
```

**Investigate a problem**
```
proxai-gateway status
proxai-gateway tail --since 1h --level warn
proxai-gateway doctor
```

**Open support ticket**
```
proxai-gateway doctor --json --include-logs > diagnostic.json
# attach diagnostic.json to support email
```

**Uninstall**
```sh
proxai-gateway uninstall
# then remove the package itself with the matching package manager:
bun rm -g @proxai/gateway
# or: pnpm rm -g @proxai/gateway
# or: yarn global remove @proxai/gateway
# or: npm uninstall -g @proxai/gateway
# or: brew uninstall proxai/tap/proxai-gateway

# or, full purge of local state too:
proxai-gateway uninstall --purge
# (then the same package-manager removal command as above)
```

---

## 7. Backend dependencies (proxai_nest API)

The CLI depends on the following endpoints. **These are gating for MVP** and should be locked with the backend team before collector code is written.

| Endpoint | Method | Used by | Body | Returns |
|---|---|---|---|---|
| `/v1/auth/validate` | POST | `install` | `{api_key}` | `{valid: bool, account_email, error?}`. **Should reuse the existing SDK auth-validate machinery — no new auth flow needed.** |
| `/v1/raw_records` | POST | `run` (uploader) | DTO per `03_FLUSHING_ALGORITHM.md` §3 with `Authorization: Bearer <api_key>` | `{accepted: int, rejected: [{id, reason}]}` |
| `/v1/health` | GET | `status`, `doctor` | — | `{ok: true, version}` |
| `/v1/gateway/latest_version` | GET | `status`, `doctor` | — | `{latest_version, release_date}` (used for stale-binary warnings) |

No dashboard work is gating for MVP — the existing API-keys page is sufficient. The user grabs any key (existing or new) from their account and pastes it into `proxai-gateway install`. A small UX nice-to-have is a "Set up Gateway" panel on the dashboard that shows the install command snippet next to the keys list, but it's not blocking.

---

## 8. Exit codes — full table

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Generic / unknown error |
| 2 | Invalid API key |
| 3 | FDA not granted |
| 4 | launchd command failed |
| 5 | Smoke-test upload failed |
| 6 | `--non-interactive` set but prompt required |
| 7 | File unreadable (`redaction-test`) |
| 10 | Paused (sentinel present) |
| 11 | Stopped (launchd unit not loaded) |
| 12 | Degraded (status / doctor) |
| 13 | Already in target state (idempotent no-op) |

Codes are stable across versions. Adding new codes is allowed; renumbering existing ones is not.

---

## 9. Open decisions for engineers

These are deliberately left for the implementing engineer's judgment, with the relevant constraints called out. Document the choice in the implementation PR.

1. **Argument parsing library.** `commander` — modern ESM build, stable API, runs cleanly under Bun. Avoid `yargs` and `oclif`.
2. **Interactive prompts.** `@inquirer/prompts` (the modular ESM rewrite of inquirer) for `install`. Do not introduce additional UX libraries elsewhere — keep `status`/`doctor` output as plain printf.
3. **Spinners.** `ora` for the install flow only (where steps are long-running). Don't sprinkle elsewhere.
4. **API key validation timeout.** Suggest 10 seconds. If the backend is slow, the user shouldn't be stuck.
5. **`status --watch` refresh default.** 5 seconds is the suggestion. Don't make it shorter; it queries the daemon over a local socket.
6. **`tail`'s log source.** Read `structured.log` directly with a tailing parser (use `Bun.file().stream()` for incremental reads). Don't shell out to `tail -f`.
7. **`doctor`'s redaction of log content.** When `--include-logs`, run the bundled redactor over each line before printing. Implies redactor is reusable as a library function.
8. **launchctl invocation.** Use `Bun.spawn` (or `node:child_process`'s `execFile`) with explicit argv; never shell out with string concatenation. The `Label` (`co.proxai.gateway`) is the only dynamic bit.
9. **Unix socket for daemon ↔ CLI.** The CLI commands `status`, `pause`, `resume`, `tail` need to talk to the running daemon. Use a Unix domain socket at `~/.proxai/control.sock`. Permissions 0600. Newline-delimited JSON-RPC. Bun's `Bun.serve({ unix: ... })` is the server side; the CLI side opens via `Bun.connect` (or `node:net`).
10. **Idempotency of `install`.** Re-running `install` should detect the existing setup and reconcile rather than blow up. If the API key in the prompt differs from the one in config, re-validate and update; don't error.
11. **Install-source detection.** Determine where the binary lives (Bun global root, Homebrew prefix, npm/pnpm/yarn global root, or a manually-placed GitHub Releases binary) by inspecting the resolved path of `argv[0]` against known prefixes. Record it in `~/.proxai/config.toml` (`install_source`). `uninstall`'s output and `status`'s "update available" hint use this to print the matching update / removal command.
