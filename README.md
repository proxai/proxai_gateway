# ProxAI Gateway

ProxAI Gateway is a managed, on-device service that captures your coding-agent activity, redacts secrets locally, and ships the redacted records to ProxAI.

## What it does

- Captures Claude Code, Cursor, and Codex agent activity directly from their on-disk session files. No proxy, no root CA, no traffic interception.
- Redacts API keys, tokens, and other secrets on-device, in a single pass, before any byte is buffered or uploaded.
- Runs as a managed background service that auto-starts on login and survives reboots.
- Observable from the command line via `status` and `tail`.

## Installation

ProxAI Gateway ships as a single self-contained native binary. You do not need Bun, Node, or any other runtime installed.

### Recommended (all platforms)

**macOS / Linux:**

```sh
curl -fsSL https://github.com/proxai/proxai_gateway/raw/main/install.sh | bash
```

**Windows (PowerShell):**

```powershell
irm https://github.com/proxai/proxai_gateway/raw/main/install.ps1 | iex
```

The script installs to a user-writable location (`~/.proxai/bin/` on macOS/Linux, `%USERPROFILE%\.proxai\bin\` on Windows). No sudo, no admin prompts.

On Linux, if you want the gateway to run when no user session is active, enable user lingering: `loginctl enable-linger $(whoami)`.

### Alternative — npm (all platforms)

```sh
npm install -g @proxai/gateway
```

The npm postinstall hook detects your platform and downloads the matching binary into the package's `bin/` directory. Same binary as the curl-bash install. Works on macOS, Linux, and Windows. Requires Node >=18 for the postinstall hook.

### Platform-specific package managers

**macOS — Homebrew:**

```sh
brew install proxai/tap/proxai-gateway
```

**Windows — Scoop:**

```powershell
scoop bucket add proxai https://github.com/proxai/scoop-bucket
scoop install proxai-gateway
```

## Quickstart

```sh
proxai-gateway setup       # configure with your ingestion key
proxai-gateway start       # register service and run
proxai-gateway status      # check it's working
```

## Commands

| Command | What it does |
| --- | --- |
| `setup` | Configure the gateway with your ingestion key. Re-run to replace. |
| `start` | Register the gateway as a managed service and start the daemon. |
| `stop` | Halt the daemon for this session. Auto-restarts on next reboot. |
| `restart` | Stop and start. |
| `status` | Print buffer state, cursors, and sentinel status. |
| `pause` | Pause polling indefinitely. Persists across reboots until `resume`. |
| `resume` | Clear an active pause. |
| `tail` | Stream structured logs from the active log file. |
| `redaction list` | List secret-redaction rules by category. |
| `redaction test <file>` | Run the redaction pipeline on a file and show what would be redacted. |
| `backfill` | Capture extended history beyond the default 30-day window. |
| `uninstall` | Decommission the service. Use `--reset` to also wipe local data. |

Run any command with `--help` for full option details.

## Where things live

### macOS

| Path | Purpose |
| --- | --- |
| `~/.proxai/proxai-gateway/config.toml` | Ingestion key and capture configuration. |
| `~/.proxai/proxai-gateway/buffer.db` | Local capture buffer (SQLite). |
| `~/Library/Logs/proxai/proxai-gateway/` | Daemon log files. |
| `~/Library/LaunchAgents/co.proxai.gateway.plist` | launchd service unit. |

### Linux

| Path | Purpose |
| --- | --- |
| `~/.proxai/proxai-gateway/config.toml` | Ingestion key and capture configuration. |
| `~/.proxai/proxai-gateway/buffer.db` | Local capture buffer (SQLite). |
| `~/.local/state/proxai/proxai-gateway/log/` | Daemon log files. |
| `~/.config/systemd/user/proxai-gateway.service` | systemd user unit. |

### Windows

| Path | Purpose |
| --- | --- |
| `%LOCALAPPDATA%\proxai\proxai-gateway\config.toml` | Ingestion key and capture configuration. |
| `%LOCALAPPDATA%\proxai\proxai-gateway\buffer.db` | Local capture buffer (SQLite). |
| `%LOCALAPPDATA%\proxai\proxai-gateway\Logs\` | Daemon log files. |
| Scheduled Task `ProxAIGateway` | Per-user task that launches the daemon at logon. |

## Troubleshooting

**Daemon isn't running.** Run `proxai-gateway status` to see service state and sentinel flags. Use `proxai-gateway tail --level error --since 1h` to surface recent errors. If you have not yet run `setup`, do that first.

**Ingestion key rejected.** The backend returned an auth error for the configured key. Re-run `proxai-gateway setup` with a fresh key from the ProxAI dashboard; the old key may have been revoked.

**How do I uninstall?** Run `proxai-gateway uninstall` to stop and unregister the service while preserving local config and logs. Run `proxai-gateway uninstall --reset` to also wipe `~/.proxai/proxai-gateway/`, the gateway log directory, and the service unit file.

## License

MIT. See [`LICENSE`](LICENSE).
