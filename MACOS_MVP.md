# macOS MVP — Platform & Implementation Plan

How the gateway runs on a Mac: installer, auto-start, file watching, and the macOS-specific sharp edges.

## 1. Decisions

- **Language: TypeScript / Node 24.** Stack alignment — `proxai_nest`, `proxai_web`, `proxai_ops` are all TypeScript. Lift CLI/build/lint/auto-updater **patterns** (not code) from `proxai_ops`; keep the gateway as a separate codebase with its own threat model and license.
- **Distribution: npm registry**, primary install command `npm install -g @proxai/gateway`. Homebrew formula and signed `.pkg` deferred to Phase 2.
- **No menu-bar in MVP.** Headless daemon. Status via `proxai-gateway status` CLI. Menu-bar tray comes in Phase 2 as a small native shell talking to the Node daemon over a local socket.
- **File watching: pure polling, every 5 minutes**, with a cheap `mtime` dirty-check before reading. FSEvents (via `chokidar`) added in Phase 2 only as a wake-up nudge.

## 2. Tech stack

| Concern | Pick |
|---|---|
| Runtime | Node 24 (ES Modules) |
| CLI | `commander` + `chalk` + `ora` + `inquirer` |
| File system | `chokidar` (FSEvents wrapper, Phase 2 only) |
| SQLite | `better-sqlite3` (sync, native, fast) |
| HTTP | stdlib `fetch` / `undici` |
| Buffer DB | `better-sqlite3` with WAL on `~/.proxai/buffer.db` |
| Test | `vitest` |
| Lint/format | ESLint + Prettier |
| Package manager (internal dev) | `pnpm` |
| Auto-start | per-user launchd LaunchAgent |

## 3. Installation

```
npm install -g @proxai/gateway
proxai-gateway install
```

`install` does:

1. Show consent screen listing exactly which directories will be read.
2. Generate `~/Library/LaunchAgents/co.proxai.gateway.plist` from a template.
3. `launchctl bootstrap gui/$(id -u) <plist>`.
4. Probe Full Disk Access by trying to read `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`. On failure, surface a deeplink to System Settings: `x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles`.
5. Print log path, pause command, status command.

Uninstall is symmetric: `launchctl bootout` → remove plist → `npm uninstall -g`.

For MVP we accept unsigned distribution. Document the right-click-Open Gatekeeper workaround. Sign + notarize in Phase 2.

## 4. Auto-start — launchd LaunchAgent

Plist at `~/Library/LaunchAgents/co.proxai.gateway.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>co.proxai.gateway</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/usr/local/lib/node_modules/@proxai/gateway/dist/bin/proxai-gateway.js</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Background</string>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key>
  <string>/Users/USERNAME/Library/Logs/proxai-gateway/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/USERNAME/Library/Logs/proxai-gateway/stderr.log</string>
  <key>WorkingDirectory</key><string>/Users/USERNAME</string>
</dict>
</plist>
```

The keys that matter:

- `KeepAlive` with `SuccessfulExit=false` — restart on crash, **stay stopped on clean exit**. So `proxai-gateway stop` actually stays stopped until next login.
- `ProcessType=Background` — proper QoS class, doesn't compete with foreground apps.
- `ThrottleInterval=30` — 30s minimum between restarts; prevents tight crash loops.

Sleep/wake is handled by launchd automatically. Network unavailability at start is fine — the SQLite buffer holds captures and the uploader retries.

## 5. File watching

The whole capture loop, every 5 minutes:

1. For each source in the bundled config:
   - `stat()` the source path (or `.vscdb-wal` for SQLite). If `mtime` unchanged: skip.
   - Otherwise: `VACUUM INTO` snapshot (SQLite) or read appended bytes (JSONL). Parse, redact, enqueue.
2. Drain the buffer to the backend.
3. Sleep until next tick.

The `mtime` check makes "nothing changed" cost ~1 ms. Active CPU per hour is < 5 seconds. This will not show up in Activity Monitor's "Apps using significant energy" list.

Cursor between polls is stored in `source_cursors`:

```sql
CREATE TABLE source_cursors (
  source_name TEXT PRIMARY KEY,    -- 'claude-code-jsonl', 'cursor-global', ...
  source_path TEXT NOT NULL,
  cursor_kind TEXT NOT NULL,       -- 'byte_offset' | 'rowid'
  cursor_value INTEGER NOT NULL,
  last_mtime INTEGER NOT NULL,
  last_polled INTEGER NOT NULL,
  consecutive_errors INTEGER NOT NULL DEFAULT 0
);
```

JSONL truncation/rotation (file shrunk below `cursor_value`): reset cursor to 0, re-ingest, emit `capture.file_rotated` event. Backend dedupes via UUIDv7.

## 6. Menu-bar — Phase 2

Deliberately not in MVP. Status via CLI: `proxai-gateway status`. Pause via `~/.proxai/PAUSED` sentinel.

When we add it (Phase 2): a small Swift `.app` shell with `NSStatusItem` that talks to the Node daemon over a local Unix socket for status / pause / resume. Same pattern as Tailscale, 1Password, Docker Desktop. Avoids bringing Electron into the daemon; keeps the daemon footprint at ~30–50 MB.

## 7. macOS gotchas

| Gotcha | What we do |
|---|---|
| **Full Disk Access (TCC)** required for some `~/Library/Application Support/Cursor/` paths on macOS 15+ | Probe at install time; deeplink to System Settings; surface in `status` if any source is failing because of it |
| **Gatekeeper** warns on first run for unsigned binaries | Document right-click-Open for MVP; sign + notarize in Phase 2 |
| **Mac App Store sandbox** would block reading other apps' data | Never ship to MAS. Direct distribution only. |
| **Sleep coalescing** can delay timer fires after wake | 5-min jitter is invisible at our cadence; no mitigation needed |
| **Network changes (VPN, Wi-Fi switch)** can stall mid-upload | `fetch` timeouts + exponential backoff; captures stay in buffer |
| **Disk space / log growth** if backend unreachable for days | Soft cap on buffer (default 500 MB); FIFO drop oldest with telemetry event |
| **Time zone / clock changes** | Use UTC + monotonic clock for intervals |
| **Path case-insensitivity (APFS default)** | Normalize via `fs.realpathSync` before comparing |

The two that matter most: **FDA** (probe at install) and **Gatekeeper** (document workaround).

## 8. MVP execution order

Listed as dependency order, not a schedule. Each block depends on the ones above; they can be parallelized within a block.

**Foundation (must come first; redaction is the critical-path safety property)**
- Repo init using `proxai_ops` build/lint/test scaffolding patterns (rewritten, not copied)
- `commander` CLI skeleton
- Redaction module + fuzz corpus + `redaction-test` subcommand. **Secrets must never escape.**

**Engines + buffer + uploader (parallel block)**
- JSONL watcher: byte-offset cursor, rotation detection, `mtime` fast-path
- SQLite watcher: `better-sqlite3` + `VACUUM INTO` snapshot, rowid cursor
- Local buffer with `source_cursors` table on `~/.proxai/buffer.db`
- HTTPS uploader to `proxai_nest` ingest stub with UUIDv7 idempotency

**Three sources (parallel block, depends on Engines)**
- Claude Code (`~/.claude/projects/*/*.jsonl`)
- Cursor (`cursorDiskKV` rows)
- Codex (`~/.codex/sessions/**/rollout-*.jsonl` + `state_*.sqlite` `threads`)
- Skip-list enforced by unit test
- End-to-end test: real session → captured raw bytes arrive in mock backend

**Install + control surface**
- `install` / `uninstall` writing the launchd plist
- FDA probe + System Settings deeplink
- Consent screen (per `USER_EXPERIENCE.md`)
- Stale-binary auto-pause (default thresholds)

**Hardening before release**
- Chaos scenarios: reboot, sleep/wake, network drop, 24h backend outage, file rotation
- README, redaction-rules doc, SBOM in CI

**Beta**
- Internal dogfooding (every ProxAI engineer runs it on their laptop)
- 1–2 friendly external customers

## 9. Open questions

1. Apple Developer account procurement — needed for Phase 2 signing; certificates take a day to issue, get it on the calendar.
2. Stale-binary thresholds (90 / 180 days?) — placeholders; calibrate from beta data.
3. FDA prevalence on Cursor's path across macOS versions — empirical question to verify during install-flow testing.
