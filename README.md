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

Run setup, then start the service:

```sh
proxai-gateway setup
proxai-gateway start
```

`setup` configures the gateway with the ingestion key from your ProxAI dashboard. `start` registers it as a background service that launches on login and keeps running across reboots.

## Check status

```sh
proxai-gateway status
```

Shows whether the gateway is active and how capture and uploads are doing.

## Manage the service

```sh
proxai-gateway stop        # stop until the next reboot
proxai-gateway restart     # stop, then start again
proxai-gateway uninstall   # remove the service — add --reset to also wipe local data
```

Run `proxai-gateway --help` to see every command.

## License

MIT — see [LICENSE](LICENSE).
