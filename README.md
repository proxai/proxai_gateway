# ProxAI Gateway

ProxAI Gateway is an on-device service that captures your coding-agent activity and ships it to ProxAI. It reads Claude Code, Cursor, and Codex session files directly from disk — no proxy, no traffic interception — and redacts API keys and other secrets on your machine before anything is uploaded.

## Install

ProxAI Gateway is a single self-contained binary — you don't need Bun, Node, or any other runtime to run it.

**macOS / Linux**

```sh
curl -fsSL https://github.com/proxai/proxai_gateway/raw/main/install.sh | bash
```

**Windows (PowerShell)**

```powershell
irm https://github.com/proxai/proxai_gateway/raw/main/install.ps1 | iex
```

**npm — any platform, requires Node 18+**

```sh
npm install -g @proxai/gateway
```

The binary installs to a user-writable location — no `sudo` and no admin prompt.

## Set up

```sh
proxai-gateway setup
```

`setup` asks for your ingestion key (from the ProxAI dashboard), verifies it, writes `~/.proxai/proxai-gateway/config.toml`, registers the gateway as a background service that launches on login, and starts the daemon. If the machine is already configured, `setup` reconciles the daemon state — starting it if it isn't running, leaving it alone if you previously paused it.

You can also pass the key inline: `proxai-gateway setup <ingestion-key>`.

## Check status

```sh
proxai-gateway status
```

Shows whether the gateway is active and how capture and uploads are doing. Refreshes live; press `q` to quit.

## Manage the service

```sh
proxai-gateway stop        # stop the daemon process for this session; the service stays registered and respawns on next reboot
proxai-gateway start       # start (or resume after stop) the daemon
proxai-gateway restart     # stop, then start
proxai-gateway update      # fetch and install the latest release (alias: upgrade)
proxai-gateway uninstall   # remove the service — add --reset to also wipe local data
```

`stop` only lasts the current session: rebooting, running `start`, re-running `setup`, or an auto-upgrade all bring the daemon back. The goal is to keep the application always running; `stop` is primarily a developer escape hatch for debugging.

Run `proxai-gateway --help` to see every command.

## License

MIT — see [LICENSE](LICENSE).
