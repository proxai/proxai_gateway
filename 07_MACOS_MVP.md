# macOS MVP — Platform & Implementation Plan

How the gateway runs on a Mac: installer, auto-start, file watching, and the macOS-specific sharp edges.

## 1. Decisions

- **Dev language: TypeScript on Bun (latest stable).** A fresh, Bun-native codebase. No Node-only tooling, no source or build config copied from any other ProxAI repo. Bun is the dev runtime, the package manager, the test runner, the SQLite driver, and the file-I/O API.
- **Shipped artifact: a single pre-compiled native executable (`proxai-gateway`).** Built with `bun build --compile`, which embeds the Bun runtime + all JS into one binary. **End users do not install Bun, Node, or any other runtime.** macOS MVP ships `bun-darwin-arm64` and `bun-darwin-x64` binaries; the same build pipeline produces Linux and Windows binaries from day one (their `install` flow lands in Phase 2 / Phase 3, but the binaries are released alongside macOS).
- **Distribution: npm + Homebrew + GitHub Releases.** Published as the npm meta-package `@proxai/gateway` with per-platform binary packages selected via `optionalDependencies` (`os` / `cpu` matrix — same pattern as `esbuild` / `oxlint`). End users install with `bun add -g`, `pnpm add -g`, `yarn global add`, `npm install -g`, or `brew install proxai/tap/proxai-gateway`, or by downloading the binary directly from GitHub Releases. Signed `.pkg` (macOS) and Authenticode signing (Windows) deferred to Phase 2.
- **No menu-bar in MVP.** Headless daemon. Status via `proxai-gateway status` CLI. Menu-bar tray comes in Phase 2 as a small native shell talking to the daemon over a local Unix socket.
- **File watching: pure polling, every 5 minutes**, with a cheap `mtime` dirty-check before reading. FSEvents added in Phase 2 only as a wake-up nudge.

## 2. Tech stack

### Dev-time

| Concern | Pick |
|---|---|
| Dev runtime | **Bun** (latest stable, ES Modules) — also bundled into the shipped binary by `bun build --compile`. End users do not install Bun. |
| Language | TypeScript strict, ESM-only (no separate `tsc` / `tsx` / `esbuild` step) |
| CLI framework | `commander` + `chalk` + `ora` + `@inquirer/prompts` (all ESM-native; `commander` chosen for its modern ESM support and stable API surface) |
| File system | `Bun.file` / `Bun.write`; `node:fs` only where Bun lacks a native equivalent. Native FSEvents-based watching (Phase 2 only) |
| SQLite | `bun:sqlite` (built-in, sync, native) — used for both consumer-DB reads and the local buffer |
| HTTP | Bun's built-in `fetch` |
| Buffer DB | `bun:sqlite` with WAL on `~/.proxai/buffer.db` |
| Test | `bun test` (Bun's built-in runner) |
| Lint / format | `oxlint` (lint) + `prettier` (format) |
| Package manager (internal dev) | `bun` (no pnpm/yarn/npm in dev) |

### Build / ship

| Concern | Pick |
|---|---|
| Compiler | `bun build --compile --target=<target> --minify ./src/cli.ts` produces the single-file native binary |
| Targets shipped MVP | `bun-darwin-arm64`, `bun-darwin-x64` (functional `install` flow) |
| Targets shipped Phase 1+ | `bun-linux-x64`, `bun-linux-arm64`, `bun-windows-x64`, `bun-windows-arm64` (binaries published alongside macOS; their platform-specific auto-start lands incrementally) |
| Binary size budget | < 100 MB after `--minify`. Strip via `--sourcemap=none --compile`. |
| npm package layout | meta-package `@proxai/gateway` (no native code; ~30 KB JS launcher shim) + per-platform packages `@proxai/gateway-{darwin,linux,win32}-{arm64,x64}` selected via `optionalDependencies` with `os` / `cpu` constraints. The launcher resolves the matching platform package's binary and execs it. |
| Homebrew | tap `proxai/tap` formula `proxai-gateway` downloads the matching binary directly from GitHub Releases. |
| GitHub Releases | All six binaries + `SHA256SUMS` + sigstore signing manifest on every tag. |
| Auto-start (macOS MVP) | per-user launchd LaunchAgent invoking the compiled binary directly |

## 3. Installation

Pick whichever package manager the user already has installed:

```sh
# Bun
bun add -g @proxai/gateway

# pnpm
pnpm add -g @proxai/gateway

# Yarn (classic + Berry)
yarn global add @proxai/gateway

# npm
npm install -g @proxai/gateway

# Homebrew (publishes a formula; tap for non-core distribution)
brew install proxai/tap/proxai-gateway
```

Then:

```sh
proxai-gateway install
```

`install` does:

1. Show consent screen listing exactly which directories will be read.
2. Generate `~/Library/LaunchAgents/co.proxai.gateway.plist` from a template.
3. `launchctl bootstrap gui/$(id -u) <plist>`.
4. Probe Full Disk Access by trying to read `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb`. On failure, surface a deeplink to System Settings: `x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles`.
5. Print log path, pause command, status command.

Uninstall is symmetric: `proxai-gateway uninstall` (which runs `launchctl bootout` and removes the plist), then the package-manager removal command that matches the install path:

```sh
bun rm -g @proxai/gateway          # bun
pnpm rm -g @proxai/gateway         # pnpm
yarn global remove @proxai/gateway # yarn
npm uninstall -g @proxai/gateway   # npm
brew uninstall proxai/tap/proxai-gateway   # Homebrew
```

For MVP we accept unsigned distribution. Document the right-click-Open Gatekeeper workaround. Sign + notarize in Phase 2.

## 4. Auto-start — launchd LaunchAgent

Plist at `~/Library/LaunchAgents/co.proxai.gateway.plist`. The shipped artifact is the compiled `proxai-gateway` binary itself — there is no separate runtime to invoke. `proxai-gateway install` resolves the absolute path of its own executable (via `realpath` of `argv[0]`, which `bun build --compile` sets correctly) and substitutes it before writing the plist:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>co.proxai.gateway</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/proxai-gateway</string>
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

The exact path varies with how the user installed:

| Install source | Typical resolved path |
|---|---|
| Homebrew (Apple Silicon) | `/opt/homebrew/bin/proxai-gateway` |
| Homebrew (Intel) | `/usr/local/bin/proxai-gateway` |
| Bun global | `~/.bun/bin/proxai-gateway` |
| pnpm global | `~/Library/pnpm/proxai-gateway` (or `pnpm root -g` equivalent) |
| Yarn / npm global | `~/.npm-global/bin/proxai-gateway` (or `npm prefix -g`) |
| GitHub Releases (manual) | `/usr/local/bin/proxai-gateway` (if user `mv`s it there) or wherever they put it |

The plist always carries an absolute path — launchd has a minimal `PATH` and won't resolve symlinks in `/usr/local/bin` reliably across macOS versions.

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

When we add it (Phase 2): a small Swift `.app` shell with `NSStatusItem` that talks to the daemon over a local Unix socket for status / pause / resume. Same pattern as Tailscale, 1Password, Docker Desktop. Avoids bringing Electron into the daemon; keeps the daemon footprint small.

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
- Repo init: fresh Bun project (`bun init`), TypeScript strict, `oxlint` + `prettier` config, `bun test` wiring, `bun build` for the daemon entry. No tooling lifted from other repos.
- `commander` CLI skeleton (ESM-only, run under Bun)
- Redaction module + fuzz corpus + `redaction-test` subcommand. **Secrets must never escape.**

**Engines + buffer + uploader (parallel block)**
- JSONL watcher: byte-offset cursor, rotation detection, `mtime` fast-path (using `Bun.file`/`Bun.stat` where possible)
- SQLite watcher: `bun:sqlite` + `VACUUM INTO` snapshot, rowid cursor
- Local buffer with `source_cursors` table on `~/.proxai/buffer.db` (`bun:sqlite`, WAL)
- HTTPS uploader to `proxai_nest` ingest stub (Bun's built-in `fetch`) with UUIDv7 idempotency

**Three sources (parallel block, depends on Engines)**
- Claude Code (`~/.claude/projects/*/*.jsonl`)
- Cursor (`cursorDiskKV` rows)
- Codex (`~/.codex/sessions/**/rollout-*.jsonl` + `state_*.sqlite` `threads`)
- Skip-list enforced by unit test
- End-to-end test: real session → captured raw bytes arrive in mock backend

**Install + control surface**
- `install` / `uninstall` writing the launchd plist
- FDA probe + System Settings deeplink
- Consent screen (per `06_USER_EXPERIENCE.md`)
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
