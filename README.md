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

Every long-form command also has a short alias.

| Command | Alias | What it does |
| --- | --- | --- |
| `setup` | `init` | Configure the gateway with your ingestion key. Re-run to replace. |
| `start` | `s` | Register the gateway as a managed service and start the daemon. |
| `stop` | `x` | Halt the daemon for this session. Auto-restarts on next reboot. |
| `restart` | `r` | Stop and start. |
| `status` | `i` | Print health, buffer state, upload metrics, and sentinel flags. |
| `inspect` | `ins` | Dry-run scan all local telemetry sources concurrently and generate a detailed report without writing to the buffer. |
| `dev` | `d` | Configure or toggle gateway development mode (on, off, or toggle). |
| `tail` | `t` | Stream structured logs from the active log file. |
| `pause` | — | Pause polling indefinitely. Persists across reboots until `resume`. |
| `resume` | — | Clear an active pause. |
| `redaction list` | — | List secret-redaction rules by category. |
| `redaction test <file>` | — | Run the redaction pipeline on a file and show what would be redacted. |
| `upgrade` | — | Manually fetch the latest release from GitHub and replace the binary. |
| `uninstall` | `rm` | Decommission the service. Use `--reset` to also wipe local data. |

Run any command with `--help` for full option details.

### Development Mode

`proxai-gateway dev` (alias `d`) allows toggling or setting development mode. When dev mode is active, the gateway forces the ingestion endpoint to `http://localhost:3001` with zero environment variable dependency, and the `status` command will display a `(dev mode)` health indicator.

```sh
proxai-gateway dev       # toggle dev mode on/off
proxai-gateway dev on    # explicitly enable dev mode
proxai-gateway dev off   # explicitly disable dev mode
```

### Version flag

Both `-v` and `--version` print the gateway version plus how this binary was installed (read from `~/.proxai/proxai-gateway/config.toml`):

```
$ proxai-gateway --version
proxai-gateway 2026.5.9-3
installed via npm
```

Recognized install sources are `bun`, `pnpm`, `yarn`, `npm`, `brew`, and `github_release`. If the config does not yet exist (before `setup`), the source falls back to `unknown`.

### Inspect Output & Dry-Run Report

`proxai-gateway inspect` (alias `ins`) scans all local developer telemetry sources concurrently in separate background threads, returning a beautifully formatted summary table in the terminal and generating a permanent, comprehensive Markdown report saved to the system's temporary directory (`tmp/proxai-gateway/reports/inspect_${timestamp}.md`).

Because `inspect` is a strict **dry-run** operations:
* It opens all local sqlite source databases in read-only mode (`readonly: true`).
* It streams long log files line-by-line via high-performance streams without loading them completely into RAM.
* It does **not** commit, modify, or buffer any telemetry data on-disk.

Example CLI output:
```
🔍 ProxAI Telemetry Dry-Run Inspection
Scanning local telemetry sources... (This is a dry-run and will not write to buffer)

📊 Telemetry Scan Summary
────────────────────────────────────────────────────────────────────────────────
Source               │   Scanned Files │   Total Records │    Data Size │ Oldest Record
────────────────────────────────────────────────────────────────────────────────
Claude Code          │               4 │             240 │     23.23 KB │ 3 days ago (2026-05-18 10:20:15)
Cursor               │               1 │            1405 │      1.42 MB │ 10 days ago (2026-05-11 12:45:00)
Codex                │               2 │             892 │    450.80 KB │ 5 hours ago (2026-05-20 19:15:30)
Gemini CLI           │               1 │              45 │      4.55 KB │ 12 minutes ago (2026-05-20 23:56:45)
────────────────────────────────────────────────────────────────────────────────
TOTAL                │               8 │            2582 │      1.89 MB │ 10 days ago (2026-05-11 12:45:00)
────────────────────────────────────────────────────────────────────────────────

💡 Highlights
  • Oldest telemetry record: 10 days ago (Source: Cursor)
  • Scan duration: 18ms

Beautiful dry-run markdown report saved to: /tmp/proxai-gateway/reports/inspect_2026-05-21T07-28-00.md
```

### Status output

`proxai-gateway status` (alias `i`) renders four sections — Capture, Buffer, Upload, Health — using the cumulative counters maintained inside the buffer database:

```
Status: ● active

── Capture ──
  claude-code      0 captured   /   64 files scanned   /  0 errors
  cursor           0 captured   /    7 files scanned   /  0 errors
  codex            0 captured   /    3 files scanned   /  0 errors

── Buffer ──
  Pending          0 batches    (0 B)        held for delivery
  Failed           0 batches    (0 B)        permanent errors retained for review
  Receipts        86 records                 successful uploads tracked
  Pressure        0 B / 700 MB  (0% soft-pause threshold)
  Last prune      8 May 13:28:50  (3 min ago)

── Upload ──
  All-time         86 batches shipped   /   12.4 MB compressed   /   54 cycles
  Avg / cycle       1.6 batches          /   0.23 MB             /   421 ms
  Last cycle       8 May 13:28:50  (3 min ago)   ·  0 attempted   0 accepted   0 retriable   0 fatal
  Last success    8 May 13:25:42  (6 min ago)   ·  3 batches      0.41 MB shipped

── Health ──
  Daemon          running          (pid 78321, uptime 3h 14m)
  Sentinels       none active
  Auto-upgrade    last check 8 May 13:28:50  ·  current 2026.5.9-3  ·  latest 2026.5.9-3 (up to date)
  Binary age      14 days  (warn ≥ 30 d, pause ≥ 60 d)
```

What each line means:

- **Capture** — last completed cycle's per-source stats: batches captured, files scanned for new content, and errors hit while reading source databases or jsonl files.
- **Buffer.Pending** — batches captured locally but not yet shipped, with the compressed byte total. When any source has pending batches, sub-rows break it down per source.
- **Buffer.Failed** — batches the server rejected as unrecoverable; kept for review until the failed-retention window expires.
- **Buffer.Receipts** — total number of successful upload receipts kept in the local buffer (a rolling window).
- **Buffer.Pressure** — current pending-byte total against the soft-pause threshold. When pressure crosses the threshold, captures pause until the buffer drains below the soft-resume threshold.
- **Buffer.Last prune** — most recent buffer-cleanup cycle (receipts and failed batches past their retention).
- **Upload.All-time** — cumulative batches shipped to the backend, total compressed bytes shipped, and total poll cycles run since install.
- **Upload.Avg / cycle** — averages derived from all-time totals.
- **Upload.Last cycle** — most recent cycle's drain results: how many batches were attempted, accepted, deferred (retriable), or rejected (fatal).
- **Upload.Last success** — most recent cycle that actually accepted at least one batch.
- **Health.Daemon** — service-manager-reported state with PID and uptime.
- **Health.Sentinels** — active sentinel flags (`paused`, `auth-failed`, `buffer-full`, `session-stopped`, `update-available`) or `none active`.
- **Health.Auto-upgrade** — when the daemon last checked GitHub for a newer release, the running version, and the latest known version. Brew installs surface a sentinel on update; npm/pnpm/yarn/bun/github_release installs auto-replace the binary in-place.
- **Health.Binary age** — days since this binary was installed, plus the configured warn / pause thresholds for stale binaries.

Add `--json` to emit a machine-readable payload of the same data.

---

## 🏗️ Worker-Based Polling & Telemetry Architecture

To deliver robust, non-blocking telemetry collection without disk locks or performance lag, the ProxAI Gateway adopts a **Multithreaded Worker-Based Polling Architecture**. 

### ⚙️ How it Works

The system utilizes a decoupled coordinator pattern where the main thread manages high-level orchestration, state persistence, and remote uploads, while background CPU workers safely carry out heavy disk I/O, secret redaction, and database queries.

```
       +───────────────────────────────────────────────+
       │              Main Thread                      │
       │  (Daemon Coordinator / Uploader / scheduler)  │
       +───────┬───────────────────────────────▲───────+
               │                               │
       [Spawns concurrently via]      [Returns capture data via]
       [Bun Native Worker API  ]      [Worker postMessage()    ]
               │                               │
        ┌──────▼─────────────────┐      ┌──────┴─────────────────┐
        │  poll-worker (Source 1)│      │  poll-worker (Source 2)│
        │      (e.g., Cursor)    │      │    (e.g., Claude Code) │
        └──────┬─────────────────┘      └──────┬─────────────────┘
               │                               │
     [Writes to its isolated]        [Writes to its isolated]
     [Private RAM Database  ]        [Private RAM Database  ]
               │                               │
        ┌──────▼────────────────┐       ┌──────▼────────────────┐
        │ Isolated in-memory DB │       │ Isolated in-memory DB │
        │   sqlite (:memory:)   │       │   sqlite (:memory:)   │
        └───────────────────────┘       └───────────────────────┘
```

### 🔒 Complete Thread Isolation & ACID Writes

To completely eliminate `SQLITE_BUSY` lock contention and race conditions when multiple sources are polled concurrently, the gateway implements strict thread isolation:

1. **Prior Cursor Loading**: Before spawning worker threads, the main thread reads the watermark positions (`source_cursors` table) from the persistent disk SQLite database (`buffer.db`) and builds a structured input.
2. **Private In-Memory Databases**: Inside each active worker thread, the gateway creates a completely isolated **in-memory SQLite database** using `bun:sqlite` (`new Database(':memory:')`). The worker loads the cursors into this private database.
3. **Local Capture and Redaction**: The worker performs scanning, secret redaction, and batches the parsed records entirely inside its local, RAM-only database.
4. **Main Thread Transaction Synchronization**: Once a worker finishes, it posts its local batches, quarantine records, and cursors back to the Main Thread via standard Web Message Channels. 
5. **ACID Safe-Commit**: The Main Thread is the **sole writer** to the persistent SQLite database on disk (`buffer.db`). It serializes updates by executing all worker results inside a single atomic transaction block:

```
[Main Thread] === (Start Transaction) ===> [Write Cursors] ===> [Write Batches] === (Commit) ===> [Persistent buffer.db]
```

This hybrid pattern guarantees that the local SQLite database never hits a lock conflict, maintaining extreme processing throughput.

---

## ❓ FAQ (Frequently Asked Questions)

### Q: Why does the gateway use multithreaded workers instead of standard asynchronous Node loops?
**A:** Traditional async loops inside Node/Bun run on a single CPU thread. If a log file is massive, or an SQLite source database is locked by the editor, parsing and querying blocks the main loop, causing lag in the status reporting and uploader cycles. Spawning separate Workers allocates real OS threads, dividing CPU work (secret redaction, Gzip compression, parsing) across multiple CPU cores.

### Q: Is there any risk of concurrent write locks on the persistent SQLite buffer database?
**A:** No. Background worker threads **never** open or write to the persistent `buffer.db` database on disk. They only read and write inside their private in-memory (`:memory:`) RAM databases. The Main Thread is the single designated writer, ensuring all inserts are done sequentially inside single thread-safe transactions.

### Q: Does the `inspect` command write data to the local database buffer?
**A:** No. The `inspect` command is a pure **dry-run** reporter. Workers spawned by `inspect` open all local SQLite files in read-only mode (`readonly: true`) and stream logs without saving any batches, cursors, or metadata to `buffer.db`.

### Q: How does the uploader pacing control database size?
**A:** The `pacer.ts` helper regulates the transmission rate based on bandwidth policies and server states. If the persistent database pending size exceeds `softPauseBytes` (e.g. 200MB), a `buffer-full` sentinel halts the capture loop. Workers will not be spawned until uploader successful drains the queue below the `softResumeBytes` threshold (e.g. 100MB), ensuring safety.

---

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
