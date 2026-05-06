# ProxAI Gateway

ProxAI Gateway is a managed, on-device service that captures your coding-agent activity (Claude Code, Cursor, Codex), redacts secrets locally, and ships the redacted records to ProxAI.

## What it does

- Captures prompts, responses, tool calls, and per-turn token counts from Claude Code, Cursor, and Codex by reading their on-disk transcript files. No proxy, no root CA, no traffic interception.
- Redacts API keys, tokens, and known secret formats on-device, in a single pass at capture time, before any byte is buffered or uploaded.
- Runs as a managed background service: launchd on macOS, systemd on Linux, Windows Task Scheduler on Windows. Starts at login; survives reboots.
- Observable from the command line: `status` for liveness, `tail` for recent activity, `redaction list` and `redaction test` for what the redactor will and will not strip.

## Installation

ProxAI Gateway ships as a single self-contained native binary. You do not need Bun, Node, or any other runtime installed.

### macOS

```sh
# Homebrew (coming soon)
brew install proxai/tap/proxai-gateway

# npm (works today)
npm install -g @proxai/gateway
```

The binary registers itself as a launchd user agent at `~/Library/LaunchAgents/co.proxai.gateway.plist` during `proxai-gateway setup`. The agent is loaded at every login.

### Linux

```sh
npm install -g @proxai/gateway
```

The binary registers itself as a systemd user unit at `~/.config/systemd/user/proxai-gateway.service` during `proxai-gateway setup`. Lingering must be enabled (`loginctl enable-linger`) for the service to run when no user session is active; the setup command will print instructions if needed.

### Windows

```sh
npm install -g @proxai/gateway
```

The binary registers itself as a per-user scheduled task named `ProxAIGateway` during `proxai-gateway setup`. The task triggers at logon.

## First-time setup

Run once after install:

```sh
proxai-gateway setup
```

This prompts for your ProxAI ingestion key, writes `~/.proxai/config.toml` (mode `0600` on POSIX), and registers the platform service unit. The daemon is started immediately on completion.

If you re-run `setup` and a config already exists, you must enter the new ingestion key twice (double-entry confirmation) before the existing config is overwritten. To bypass the prompt non-interactively, pass `--api-key <key>`.

## Lifecycle

```sh
proxai-gateway start      # start the service if stopped
proxai-gateway stop       # stop the service (capture pauses, no data loss)
proxai-gateway restart    # stop then start
```

`start`/`stop`/`restart` are thin wrappers over the platform service manager (launchctl / systemctl --user / schtasks).

## Inspecting activity

```sh
proxai-gateway status                  # daemon liveness + last upload time
proxai-gateway tail                    # follow the structured log
proxai-gateway tail --since 1h         # show entries from the last hour, then follow
proxai-gateway tail --level warn       # filter to warn and above
```

`--since` accepts `Nm`, `Nh`, `Nd`. `--level` accepts `debug`, `info`, `warn`, `error`. The two flags compose.

## Redaction

```sh
proxai-gateway redaction list                 # all enabled redaction rules
proxai-gateway redaction list --categories    # rules grouped by category
proxai-gateway redaction test <file>          # run rules against a file, show what would be replaced
```

Redaction is single-pass and runs at the moment of capture, before the record is written to the local buffer. Rules cover the common provider-key formats (Anthropic, OpenAI, Google, AWS, GitHub PATs, Stripe, JWTs, GCP service accounts) plus the `gitleaks` and `detect-secrets` corpora. Matches are replaced with `[REDACTED:type]`. The backend re-runs redaction on receive as defense in depth.

## Troubleshooting

**Daemon will not start.** Run `proxai-gateway status` for the unit state and last-known error. If the daemon is failing on startup, `proxai-gateway tail --level error --since 1h` will show recent stack traces. On macOS, ensure the launchd plist is loaded: `launchctl print gui/$(id -u)/co.proxai.gateway`.

**Ingestion key rejected.** The backend returned 401/403 for the configured key. Re-run `proxai-gateway setup` with a fresh key from the ProxAI dashboard. The setup command will detect the existing config and require double-entry of the new key.

**How do I uninstall?** There is no `uninstall` command — by policy, captured records remain in the local buffer and on the backend per ProxAI's data-retention terms. To stop and remove the gateway manually:

1. `proxai-gateway stop`
2. Remove the platform service unit (`~/Library/LaunchAgents/co.proxai.gateway.plist` on macOS, `~/.config/systemd/user/proxai-gateway.service` on Linux, the `ProxAIGateway` scheduled task on Windows).
3. Delete `~/.proxai/` to remove the local buffer, config, and sentinels.
4. Uninstall the package (`npm uninstall -g @proxai/gateway` or `brew uninstall proxai/tap/proxai-gateway`).

## License

MIT. See [`LICENSE`](LICENSE).
