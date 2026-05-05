# ProxAI Gateway — Design

**Status:** v0.3 (simplified for MVP)
**Owner:** ProxAI
**Last updated:** 2026-04-28

---

## 1. What it is

A background service that watches the on-disk transcripts of three coding agents — Claude Code, Cursor, and Codex — applies secret redaction, and ships the bytes to ProxAI's backend. The backend parses them into `CallRecord`s.

- Polling cadence: every 5 minutes.
- Auto-starts at login (per-user launchd LaunchAgent on macOS; per-user systemd unit on Linux; per-user Scheduled Task / Service on Windows — MVP ships macOS first; Linux and Windows binaries are produced by the same build pipeline from day one).
- Open-source (Apache 2.0).
- **Shipped as a single pre-compiled native executable** per OS / architecture. End users do **not** install Bun or Node — the runtime is bundled into the binary by `bun build --compile`. Distribution channels: the npm package `@proxai/gateway` (installable via `bun`, `pnpm`, `yarn`, or `npm` — a small optional-dependency matrix selects the platform binary at install time, the same pattern `esbuild` / `oxlint` / `swc` use), a Homebrew formula on macOS and Linux, and signed binaries on GitHub Releases for direct download.

The codebase is written in TypeScript on Bun, but Bun is a **dev-time** dependency only. End users never see it.

Antigravity is **deferred** — its conversations are AEAD-encrypted at rest with a private protobuf schema. See §5 for the investigation; not in scope for MVP or Phase 2.

---

## 2. Architecture

Two components, sharp split:

```
┌──────────────────────────────────────────────────┐
│  proxai-gateway  (this repo, on the laptop)      │
│                                                  │
│   Bundled in binary (no dynamic config in MVP):  │
│    • Source list (paths per agent)               │
│    • Redaction rules                             │
│    • Path allowlist                              │
│    • Ingest URL                                  │
│                                                  │
│   Engines:                                       │
│    • JSONL watcher                               │
│    • SQLite watcher (WAL-safe via VACUUM INTO)   │
│    • Redaction engine                            │
│                                                  │
│   Loop, every 5 min:                             │
│    read new bytes → redact → buffer → upload     │
│                                                  │
└────────────────────────┬─────────────────────────┘
                         ▼
┌──────────────────────────────────────────────────┐
│  proxai_nest  (separate repo, ProxAI backend)    │
│                                                  │
│   /v1/raw_records  →  object storage             │
│      ↓                                           │
│   Per-agent parser  →  CallRecord                │
│   (versioned, re-runnable on demand)             │
│                                                  │
└──────────────────────────────────────────────────┘
```

### Why this split

- **Schema drift fixes ship without a client release.** When Cursor renames `inputTokens` to `input_tokens` in `_v:14`, we update the backend parser and re-run it over historical raw bytes. Laptops don't update.
- **The client stays small and stable.** Engines + redaction + buffer + uploader. No parsing, no normalization, no schema knowledge.
- **Re-parsing historical data becomes routine.** Whenever we improve a parser, we can re-derive `CallRecord`s from the raw blobs in object storage.

### The hard line: redaction stays on the laptop

Redaction is the only transform the gateway performs. It must stay client-side, because raw bytes contain provider API keys and developer-typed secrets that must not reach our backend in plaintext — even briefly. The backend re-redacts on receive as defense in depth, but that's the safety net, not the primary control.

---

## 3. Privacy & redaction

Captured payloads contain source code, internal docs, prompts about unreleased features, and frequently API keys or tokens that the developer pasted into a prompt. The product is sold to **employers** but runs on **employee** machines, so:

- Installer shows a clear consent screen listing exactly which directories will be read.
- `~/.proxai/PAUSED` sentinel file (or menu-bar toggle, Phase 2) immediately disables capture without uninstalling.
- README and onboarding call out: "this captures the full content of your coding-agent conversations, including code."
- Local capture log readable by the developer at any time — the trust escape valve.

### Three redaction stages

1. **Gateway, write-time.** `gitleaks` rule corpus + auth-header strip. Replaces matches with `[REDACTED:type]` before the bytes go anywhere.
2. **Gateway, upload-time.** Independent regex pass with a different rule corpus (`detect-secrets` patterns). Catches Stage-1 bugs.
3. **Backend, ingest-time.** Third pass on receive. Catches stale client rules.

Rules and corpus are **bundled with the gateway binary** in MVP. Updating the rule set means re-running the global install (`bun add -g @proxai/gateway@latest`, or the equivalent under pnpm / yarn / npm / Homebrew). See §8 for safety nets that bound the lag.

The redaction module and its fuzz corpus get built **before** any collector code.

---

## 4. What we capture per agent

Operational details (exact paths, what's inside each file, files to never read) live in `03_FLUSHING_ALGORITHM.md`. Summary table here:

| Agent | What we read | Format | Verified |
|---|---|---|---|
| **Claude Code** | `~/.claude/projects/*/*.jsonl` | Append-only JSONL; per-line types `user` / `assistant` / `system` / `tool_use` / `tool_result` / etc. Plaintext. | ✓ on this machine |
| **Cursor** | `~/Library/Application Support/Cursor/User/{global,workspace}Storage/**/state.vscdb`, table `cursorDiskKV`, key prefixes `composerData:` / `bubbleId:` | SQLite KV; values are versioned JSON (`_v:N`). Plaintext. | ✓ on this machine |
| **Codex** | `~/.codex/sessions/*/*/*/rollout-*.jsonl` (rollouts) + `~/.codex/state_*.sqlite` `threads` table (sidecar metadata) | JSONL with `{timestamp, type, payload}` envelope; sidecar SQLite versioned by filename. Plaintext. | ✓ on this machine |
| Antigravity | `~/.gemini/antigravity/conversations/<uuid>.pb` | **AEAD-encrypted** with key in login keychain `Antigravity Safe Storage`. Schema is private protobuf. | Investigated; deferred to Phase 4. |

Three Anthropic-style cache fields, Cursor `toolFormerData`, Codex `dynamic_tools`, etc. — see `05_AGENT_CALL_RECORD_MAPPING.md` for the full per-field mapping (a backend-side concern).

---

## 5. Version-tolerant collection

General principles applied by every collector:

- **Glob, don't hardcode.** `state_*.sqlite` not `state_5.sqlite`. Pick highest-numbered when multiple match.
- **Introspect SQLite via `sqlite_master`** before reading; if the expected table is missing, log and skip rather than crash.
- **Capture upstream version markers** with every record (`version` for Claude Code, `_v` for Cursor blobs, `cli_version` for Codex). The backend parser dispatches on these.
- **Per-line / per-row failure isolation.** One bad line doesn't abort the file.
- **Ship raw, parse server.** If we don't recognize the shape, the raw bytes still go up; the backend gets to figure it out.

Per-agent invariants we bet on:

- **Claude Code:** files at `~/.claude/projects/*/*.jsonl`, JSONL append-only, every line has `type` + `timestamp` + `sessionId`.
- **Cursor:** table `cursorDiskKV` exists, key prefixes `composerData:` and `bubbleId:` are stable, values are JSON with `_v`.
- **Codex:** every JSONL line is `{timestamp, type, payload}`; state DB matches `state_*.sqlite`; table `threads` exists.

If any of these break, the affected collector logs and pauses; other collectors keep working.

---

## 6. Tech stack

### Dev-time tooling (what we use to write and test the code)

| Concern | Pick |
|---|---|
| Language | TypeScript (strict, ESM-only) |
| Dev runtime | **Bun** (latest stable). Also the runtime that gets bundled into the shipped binary by `bun build --compile`. End users do not install Bun. |
| CLI framework | `commander` (full ESM, modern Node/Bun support, stable, no transpile shims) + `chalk` + `ora` + `@inquirer/prompts` |
| File system | `Bun.file` / `Bun.write` for reads and writes; `node:fs` (Bun-supported) only where Bun does not yet expose a native equivalent (e.g., `fs.realpathSync`, `fs.statSync` edge cases). Native FSEvents-based watching deferred to Phase 2 as a wake-up nudge; MVP is pure polling. |
| SQLite | `bun:sqlite` (built-in, sync, native) for both consumer-DB reads and the local buffer; `?mode=ro` + `VACUUM INTO` snapshot for WAL safety. No `better-sqlite3` dependency. |
| Outbound HTTP | Bun's built-in `fetch` |
| Redaction | `gitleaks` + `detect-secrets` rule corpora ported to JS regex |
| Logging | `pino` → JSON in the platform-appropriate log dir (`~/Library/Logs/proxai-gateway/` on macOS; `~/.local/state/proxai-gateway/log/` on Linux; `%LOCALAPPDATA%\proxai-gateway\Logs\` on Windows) |
| Internal package manager | `bun install`, `bun test`, `bun build`. No pnpm/yarn/npm in dev. |
| Auto-start | launchd LaunchAgent (macOS); systemd user unit (Linux); Scheduled Task (Windows). MVP ships macOS first; the Linux and Windows binaries are produced by the same build pipeline from day one. |
| Lint / format | `oxlint` (lint) + `prettier` (format). No ESLint. |
| Testing | `bun test` (Bun's built-in test runner); golden-file tests against captured fixtures |

### Build & distribution (what end users get)

End users get **one self-contained native executable** per OS / arch. They do not install Bun or Node.

| Concern | Pick |
|---|---|
| Build command | `bun build --compile --target=<target> --minify ./src/cli.ts --outfile dist/<target>/proxai-gateway[.exe]` |
| Compiled targets | `bun-darwin-arm64`, `bun-darwin-x64`, `bun-linux-x64`, `bun-linux-arm64`, `bun-windows-x64`, `bun-windows-arm64`. Each output is a single self-contained binary with the Bun runtime bundled in (~50–90 MB). |
| npm publication | `@proxai/gateway` is the meta-package (no native code itself, ~30 KB). It declares `optionalDependencies` on six platform packages — `@proxai/gateway-darwin-arm64`, `@proxai/gateway-darwin-x64`, `@proxai/gateway-linux-x64`, `@proxai/gateway-linux-arm64`, `@proxai/gateway-win32-x64`, `@proxai/gateway-win32-arm64` — each pinned with `os` / `cpu` fields so `bun`/`pnpm`/`yarn`/`npm` install only the matching one. The meta-package's `bin` is a tiny launcher shim (Node-compatible JS, ~30 lines) that resolves and execs the platform binary. Pattern verified by `esbuild`, `oxlint`, `swc`, `lightningcss`, `biome`. |
| Homebrew | A formula in tap `proxai/tap` (`proxai-gateway`) pulls the matching macOS or Linux binary directly from GitHub Releases. No npm involved. |
| GitHub Releases | All six binaries + `SHA256SUMS` + a sigstore/cosign signing manifest attached to every tag. Direct-download install path for users who can't or won't go through a package manager. |
| Code signing | macOS: Developer ID + notarization (Phase 2). Windows: Authenticode (Phase 2). Linux: detached signature on GitHub Releases. MVP ships unsigned binaries with the documented Gatekeeper / SmartScreen workarounds. |

### Codebase posture

The repo is a fresh codebase: no source, scaffolding, or build configuration is copied from any other ProxAI repo. The threat model (customer machines, developer secrets in scope), the license (Apache 2.0, OSS), and the auditability bar are unique to the gateway and drive its tooling choices.

No proxy server, no MITM, no signed-config plumbing — all dropped from MVP. See `07_MACOS_MVP.md` for the full macOS implementation plan.

---

## 7. Auto-start & updates

### Auto-start
Per-user LaunchAgent at `~/Library/LaunchAgents/co.proxai.gateway.plist`. `RunAtLoad=true`, `KeepAlive` only on crash, `ProcessType=Background`. Logs to `~/Library/Logs/proxai-gateway/`.

`KeepAlive` is set so launchd restarts on crash but **not** on clean exit — `proxai-gateway stop` actually stays stopped until next login.

### Update story (MVP)
- Distribution: npm registry as `@proxai/gateway` (meta-package + per-platform binary packages, see §6 "Build & distribution"), plus a Homebrew tap (`proxai/tap/proxai-gateway`), plus signed binaries on GitHub Releases.
- Update mechanism: re-run the global install with `@latest` and then `proxai-gateway start`. The user's chosen package manager pulls the new platform binary; no Bun or Node install is involved. Examples:
  - `bun add -g @proxai/gateway@latest`
  - `pnpm add -g @proxai/gateway@latest`
  - `yarn global add @proxai/gateway@latest`
  - `npm install -g @proxai/gateway@latest`
  - `brew upgrade proxai/tap/proxai-gateway`
  - Or download the new binary from GitHub Releases and replace it on disk.
- Update prompt: menu-bar tray (Phase 2). For MVP, an out-of-date warning surfaces in `proxai-gateway status` output.
- **Stale-binary auto-pause** is the safety net: if the gateway's release date is older than 90 days, it logs a warning daily; older than 180 days, it stops uploading until the user updates. This bounds the "user on old redaction rules" exposure.

The dynamic-config / signed-config story (push rules without client release) is **out of MVP scope** — see Phase 3. The MVP cadence is "minor releases on demand, hotfix when a major provider changes a key format."

---

## 8. MVP scope

### In

1. Three collectors (Claude Code JSONL, Cursor SQLite, Codex JSONL + sidecar).
2. Two-stage gateway redaction (`gitleaks` + `detect-secrets`), bundled rules.
3. SQLite WAL buffer with idempotency on UUIDv7 derived from `(source_path, source_ref)`.
4. Uploader: HTTPS POST to `proxai_nest` ingest endpoint, batched, exponential backoff.
5. CLI: `install`, `uninstall`, `start`, `stop`, `status`, `pause`, `resume`, `tail`, `redaction-test <file>`.
6. Installer: writes launchd plist; **no shell-profile changes needed**, no env vars.
7. `~/.proxai/PAUSED` sentinel kill switch.
8. Hardcoded path allowlist (`~/.claude/`, `~/.codex/`, `~/Library/Application Support/Cursor/`).
9. Hard-skip blacklist enforced by unit test (`~/.codex/auth.json`, Cursor `ItemTable`, etc. — see `03_FLUSHING_ALGORITHM.md`).
10. Stale-binary auto-pause.
11. Open-source repo with README, CONTRIBUTING, LICENSE (Apache 2.0), threat model, redaction-rules doc.

### Out

- Antigravity (Phase 4 / customer-pulled)
- Dynamic config — signed remote rules / source list (Phase 3)
- HTTP proxy / base-URL override (Phase 2, opt-in)
- Hooks-based collection (Phase 2)
- Menu-bar tray UI (Phase 2)
- Linux `install` flow + systemd user unit (Phase 2). Linux binaries (`bun-linux-x64`, `bun-linux-arm64`) are produced and published from day one; only the platform-specific install / auto-start surface lands later.
- Windows `install` flow + Scheduled Task (Phase 3). Windows binaries (`bun-windows-x64`, `bun-windows-arm64`) are produced and published from day one; same caveat.
- MITM mode (deprioritized; may never ship)

### Success criteria

- Developer installs the binary through any supported channel (`brew install proxai/tap/proxai-gateway`, `bun add -g @proxai/gateway`, `pnpm add -g @proxai/gateway`, `yarn global add @proxai/gateway`, `npm install -g @proxai/gateway`, or a direct download from GitHub Releases) **without installing Bun, Node, or any other runtime**, runs `proxai-gateway install`, reboots, uses the three agents normally for a day → backend has a complete, redacted, raw-byte record of every turn within 5 min of it occurring.
- Zero captured rows contain raw `Authorization` headers, `x-api-key` headers, or matched `gitleaks` patterns. Verified via fuzz test corpus.
- Service survives reboot, sleep/wake, network drop, and 24h backend outage without losing captures (chaos-tested).
- p99 read overhead per poll cycle < 200 ms.

---

## 9. Roadmap

### Phase 0 — groundwork
- Repo skeleton, CI, Apache 2.0 license, threat model, SBOM
- Redaction module + fuzz corpus (critical-path)
- Lock the `proxai_nest` raw-ingest contract
- Verification spikes — already done in this thread for all three MVP agents

### Phase 1 — MVP
- Three collectors + buffer + uploader
- launchd installer + `commander`-based CLI
- Internal dogfooding by ProxAI engineers
- Beta with 1–2 friendly customers

### Phase 2 — comfort & coverage
- Menu-bar tray (rumps): status, last-upload, pause toggle, update prompt
- Optional HTTP proxy (`ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL`) for users who want realtime in addition to polling
- Hooks-based Claude Code collector for sub-poll-interval freshness
- Linux support (systemd user unit, identical collector code)

### Phase 3 — enterprise polish
- Self-hosted backend mode for security-sensitive customers
- MDM-friendly install package (signed `.pkg`)
- SOC 2 Type 1 evidence collection
- Local web UI at `127.0.0.1:8788/_proxai/` for "what got captured today"
- Windows support
- **Dynamic config** (signed remote rules + source list) — once we've outgrown the bundled-binary update model

### Phase 4 — hard targets (customer-pulled only)
- Antigravity collector (reverse-engineer the protobuf schema, AEAD decryption against the keychain item, install-time consent for the keychain prompt, version-pinned)
- Optional MITM mode — only if a real customer asks
- Team analytics / policy mode — separate product surfaces

---

## 10. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Redaction misses a secret | Medium | Catastrophic | Three-stage redaction; fuzz corpus; backend re-redact |
| Client on stale rules leaks new format | Medium | High | Stale-binary auto-pause + backend re-redact |
| Agent vendor changes on-disk schema | High over time | Low (it's just a backend parser update) | Version markers carried per record; raw bytes preserved; backend re-parses |
| WAL race when reading Cursor's live DB | Medium | Medium | `VACUUM INTO` snapshot before parse; never write to consumer DBs |
| Customer perceives this as spyware | Medium | Catastrophic | Consent-first install; pause sentinel; user-readable capture log; open source |
| Apple changes launchd / SQLite WAL semantics | Low per release | Medium | Keep integrations minimal and standard |

---

## 11. Open questions

1. `proxai_nest` raw-ingest contract: owned by backend team; lock before MVP code-freeze.
2. Anonymous gateway-self-telemetry (crash counts, version): opt-in at install time.
3. Stale-binary thresholds (90/180 days?): pick after enough beta data to calibrate.

---

## 12. Next steps

1. Lock the `proxai_nest` raw-ingest envelope shape with the backend team.
2. Build the redaction module + fuzz corpus.
3. Implement the three collectors in parallel — they share buffer/uploader/redactor.
4. Build the launchd installer + CLI alongside.
