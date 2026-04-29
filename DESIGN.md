# ProxAI Gateway — Design Document

**Status:** Draft v0.2
**Owner:** ProxAI
**Last updated:** 2026-04-28

---

## 1. Problem statement

We want an open-source agent that runs on a developer's macOS machine and captures the LLM interactions of their coding agents — Claude Code, Cursor, Codex, Google Antigravity, and similar — then forwards a structured, redacted record of those interactions to a ProxAI backend.

**Capture, not intercept.** The original framing of "listen on a port" assumed the gateway had to position itself in the network path between the agent and its upstream API. Investigation of the four tools we care about shows that all of them already write rich, structured transcripts to local disk. **Reading those transcripts is strictly better than network interception:**

- It captures full agent trajectories — prompts, completions, tool calls, tool results — including data the network call never carried in this form (locally-resolved file context, attached diffs, indexed code chunks).
- It avoids TLS interception, root CA installation, certificate pinning, and per-tool proxy configuration.
- It works regardless of whether the user is on first-party API keys, BYOK mode, or a vendor's hosted backend.

The price is that capture is **near-realtime, not live** — bubbles and turns appear after the agent finishes writing them. Per the product requirement, that's fine. **A polling collector running every 5 minutes is the assumed cadence.**

Network interception (HTTP proxy / MITM) is retained in the design only as a fallback for clients that genuinely don't write usable on-disk state.

---

## 2. Goals and non-goals

### Goals
- Capture coding-agent LLM activity from Claude Code, Cursor, and Codex on macOS
- Best-effort support for Google Antigravity once its on-disk format is verified
- Run as a persistent background service with auto-start at login
- Polling cadence ~5 min, with WAL-aware reads to avoid corrupting live writers
- Buffer locally; survive offline / backend outages with at-least-once delivery
- Ship as `pip install proxai-gateway && proxai-gateway install`, no Xcode required
- Open-source (Apache 2.0)
- Adopt industry-standard observability data shapes so customers can plug in OTEL-compatible tooling

### Non-goals (for v1)
- Windows or Linux support (macOS first; Linux follows)
- Realtime streaming capture (we explicitly do not need it)
- Modifying or filtering traffic — read-only observability
- A laptop UI — capture is headless; visualization is in the cloud product
- Capturing non-LLM traffic
- Kernel extension or signed Network Extension (deferred indefinitely)

### Constraints
- **Python codebase** (per requirement)
- **macOS-first**
- **No root required for steady-state operation.** Install may prompt once for keychain trust if the optional MITM mode is enabled; the running service is a per-user LaunchAgent.

---

## 3. Privacy, industry standards, and trust

### 3.1 Privacy posture

Captured payloads contain source code, internal docs, prompts about unreleased features, and frequently API keys or tokens that the developer pasted into a prompt. The product is sold to **employers** but runs on **employee** machines, so consent and disclosure are required:

- Installer must show a clear consent screen listing exactly what is captured and which directories will be read.
- A `~/.proxai/PAUSED` sentinel file (or menu-bar toggle, post-MVP) immediately disables capture without uninstalling.
- README and onboarding must call out: "this captures the full content of your coding-agent conversations, including code."
- Capture log (what was read, when, redaction summary) is locally readable by the developer at any time — this is the trust escape valve.

### 3.2 Redaction (defense in depth)

Redaction runs in **two stages with different rules**, on the principle that one bug in one stage shouldn't be sufficient to leak.

- **Stage 1 (write-time, in the collector):** strip auth headers (where applicable), regex-match common secret formats (AWS keys, GitHub PATs, Stripe keys, JWTs, GCP service-account JSON, Anthropic/OpenAI/Google API keys), replace with `[REDACTED:type]`. Use the `gitleaks` rule corpus as the base set.
- **Stage 2 (upload-time):** independent regex pass with a different implementation (e.g. `detect-secrets` patterns) before the HTTPS POST. Even if Stage 1 has a regex bug, Stage 2 must catch it.
- **Stage 3 (backend ingest):** a third pass on receive. Defense in depth all the way down.

Redaction is on the critical path. The redaction module and its test corpus get built **before** any collector code.

### 3.3 Industry standards we adopt

This is brief by design — the product should slot into existing observability stacks, not invent its own.

| Standard | What we adopt | Why |
|---|---|---|
| **OpenTelemetry (OTLP)** | OTLP/HTTP as our wire format from gateway → backend; OTLP semantic conventions for LLM data (`gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.prompt`, `gen_ai.completion`, `gen_ai.tool.*`) | The dominant observability standard. Both Claude Code and Codex already export OTEL natively. Customers can dual-export to their own OTEL backend (Datadog, Honeycomb, Grafana) without changing anything. |
| **OpenInference / OpenLLMetry** semantic conventions | Field names for LLM-specific concepts not yet in OTEL stable (agent steps, tool call hierarchies, message roles) | These are the de-facto standards in the LLM observability space (Arize, Traceloop, Langfuse). Aligning means our data renders in their UIs out of the box. |
| **CycloneDX SBOM** | Generated on every release | Customers will demand it for SOC 2 / vendor review. Cheap to add, expensive to retrofit. |
| **`gitleaks` / `detect-secrets` rule corpora** | Used as Stage 1 / Stage 2 redaction baselines | Battle-tested rule sets. Don't roll our own regex catalogue. |
| **At-least-once delivery + idempotency keys** | Each capture has a stable UUIDv7 ID; uploads are idempotent on that ID | Standard distributed-systems hygiene. Lets us retry freely without dedup logic in the backend. |
| **WAL-aware SQLite reads** | Open consumer DBs read-only with `?mode=ro&immutable=0`; for hot reads, snapshot via `VACUUM INTO` to a temp DB before parsing | Cursor and other VS Code forks write under WAL. A naive reader can race the writer or read torn pages. |
| **Schema versioning** | All captured payloads carry a `_v:N` field; collector parsers are version-pinned with a "store raw blob if unrecognized" fallback | Mirrors what Cursor itself does; survives upstream schema changes without data loss. |
| **mTLS or signed-token auth + TLS 1.3** for gateway → backend | Bearer token (per-install, rotatable) over TLS 1.3 in MVP; mTLS optional for enterprise | Industry baseline for telemetry agents (Datadog, NewRelic, Honeycomb agents all do equivalent). |

The bullet version: **OTLP for transport, `gen_ai.*` semantic conventions for shape, `gitleaks` corpus for redaction, SQLite-WAL for buffer, UUIDv7 for idempotency.** Nothing exotic.

---

## 4. Capture strategies — the ladder

Four mechanisms, ordered from "preferred" to "last resort". The architecture supports all four; per-tool sections in §5 pick the appropriate ones.

### 4.1 On-disk transcript watcher (PRIMARY)
Read structured transcript files the agent writes itself. Poll every 5 min, track a per-file cursor (offset for JSONL, last-seen rowid for SQLite), parse newly-appended records, redact, enqueue.

**Pros:** no agent configuration, no TLS issues, no proxy code, captures full trajectory including tool I/O. **Cons:** schema is undocumented and version-tagged — needs versioned parsers and a raw-blob fallback for unrecognized versions.

### 4.2 Hook / notifier integration (COMPLEMENTARY)
Some agents (Claude Code, Codex) expose pre/post-event hooks that fire on tool use, message, or session events. We register a hook that writes a small structured record into our buffer.

**Pros:** realtime; doesn't require schema reverse-engineering; officially supported. **Cons:** per-agent integration; agent-specific config to install.

### 4.3 Reverse proxy via base-URL override (FALLBACK)
Local HTTP server on `127.0.0.1:8788`, agents pointed at it via `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` / etc.

**Pros:** doesn't depend on transcript schemas. **Cons:** requires shell-profile env vars; does nothing for tools that hit a vendor backend (`api.cursor.sh`).

### 4.4 Transparent MITM with custom CA (LAST RESORT)
mitmproxy + system proxy + trusted root CA in login keychain.

**Pros:** catches everything that doesn't pin certs. **Cons:** requires CA install (real security ask); breaks loudly on pinned clients. **Shipped only opt-in, never default.**

---

## 5. Per-tool capture mechanisms

Each subsection answers: **what capture mechanisms exist, what data they yield, and which one we pick.**

### 5.1 Claude Code

**Verified on this machine** at `~/.claude/`.

| Mechanism | Path / surface | Data captured | Cost |
|---|---|---|---|
| **JSONL session transcripts** | `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl` | Per-session, append-only JSONL. Entry types: `user`, `assistant`, `system`, `attachment`, `tool_use`, `tool_result`, `file-history-snapshot`, `permission-mode`, `ai-title`, `last-prompt`. Plain JSON, no encryption. | None — files exist by default |
| **Hooks** | `~/.claude/settings.json` `hooks` block (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `Notification`, etc.) | Realtime event callbacks; we run a small script that writes to our buffer | Adds entries to user's `settings.json` |
| **OTEL telemetry** | `CLAUDE_CODE_ENABLE_TELEMETRY=1` + `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:8788/otel` | Native OTLP metrics + log events for prompts/completions, token usage | Two env vars |
| **HTTP base-URL override** | `ANTHROPIC_BASE_URL=http://127.0.0.1:8788/anthropic` | Live request/response bodies | Env var; intercepts every API call |

The `~/.claude/projects/.../*.jsonl` layout also persists `last-prompt`, `attachment`, and full `assistant` turns including tool calls and results. On this machine a single project's session file was 216 KB after a few hours of work — comfortable polling territory.

**Choice:** JSONL watcher as primary (zero-config, complete coverage). OTEL endpoint exposed as a complementary path for users who want true realtime. Hooks reserved for events the JSONL doesn't carry (e.g., user-pause signals). HTTP proxy not used for Claude Code.

### 5.2 Cursor

**Verified on this machine** at `~/Library/Application Support/Cursor/`.

| Mechanism | Path / surface | Data captured | Cost |
|---|---|---|---|
| **Global SQLite store** | `User/globalStorage/state.vscdb`, table `cursorDiskKV` | `composerData:<id>` rows = conversation metadata (title, mode, token usage, ordered bubble list). `bubbleId:<composerId>:<bubbleId>` rows = per-message bubbles with full plaintext `text`, `richText`, `modelInfo`, `tokenCount`, `toolFormerData` (tool name + raw args + full result), `attachedCodeChunks`, `webReferences`, `mcpDescriptors`, `cursorRules`, timestamps. Plain JSON, no encryption. Schema-versioned (`_v:3` for bubbles, `_v:13` for composers). | None |
| **Per-workspace SQLite** | `User/workspaceStorage/<hash>/state.vscdb` | Workspace-scoped chat state | None |
| **BYOK base-URL override** | Cursor Settings → "OpenAI Base URL" (manual, per-user) | Live API bodies for users on their own keys | User-managed setting |
| **MITM proxy** | System proxy + custom CA | All Cursor↔`api.cursor.sh` traffic that doesn't pin | High; some endpoints likely pinned |
| **MCP servers** | Cursor MCP integration | **Insufficient.** MCP servers see only the LLM-chosen arguments to *their own* tool. They do not see prompts, completions, or other tools' calls. Not viable as a primary capture mechanism. | n/a |

The investigation in this thread confirmed: 89 bubbles + 33 composers in `cursorDiskKV` here, plain JSON, full tool-call traces present (one assistant bubble carried a 101 KB `semantic_search_full` tool result inline). `ItemTable` in the same DB also stores `cursorAuth/accessToken` — the collector must hard-skip that table.

**Choice:** SQLite watcher as primary, polling both `globalStorage/state.vscdb` and each `workspaceStorage/*/state.vscdb`. Track last-seen `rowid` per table. Snapshot via `VACUUM INTO` before parsing to avoid racing the writer. BYOK proxy retained as a complementary realtime path. MITM dropped from the roadmap.

### 5.3 Codex (OpenAI Codex CLI)

**Not installed on this machine — section based on public docs and code, flagged for verification.**

The current Codex CLI is the open-source Rust rewrite (not the deprecated Codex API of 2021). Expected mechanisms:

| Mechanism | Path / surface | Data captured | Confidence |
|---|---|---|---|
| **JSONL session rollouts** | `~/.codex/sessions/YYYY/MM/DD/rollout-<session-id>.jsonl` (date-sharded) | Append-only JSONL with `user`, `assistant`, `function_call`, `function_call_output` entries. Plain JSON. | High — documented |
| **OTEL telemetry** | OTLP exporter via `OTEL_EXPORTER_OTLP_ENDPOINT` and Codex's `[telemetry]` config block | Native OTLP traces/metrics, with `gen_ai.*` semantic conventions | High — documented |
| **Notify hook** | `notify = ["/path/to/script", "..."]` in `~/.codex/config.toml` | Fires on session events (turn complete, tool call), passes a JSON payload to the script | High — documented |
| **HTTP base-URL override** | `~/.codex/config.toml` `[providers]` block, or `OPENAI_BASE_URL` | Live API bodies | High |
| **MCP servers** | Codex `[mcp_servers]` config | Same limitation as Cursor MCP — partial visibility only | n/a |

**Choice:** JSONL rollout watcher as primary, mirroring the Claude Code approach. OTEL endpoint as complementary path. `notify` hook used for session-boundary signals. HTTP proxy not used. **Action:** install Codex on a dev machine and verify the rollout file format and field names before committing the parser to MVP-eligible status.

### 5.4 Google Antigravity

**Not installed on this machine — section is informed speculation, flagged accordingly.**

Antigravity is Google's IDE, announced in late 2025. Public information suggests it is a VS Code fork (like Cursor) with deep Gemini integration. Expected — and to be verified — mechanisms:

| Mechanism | Path / surface | Data captured | Confidence |
|---|---|---|---|
| **SQLite + globalStorage** | Likely `~/Library/Application Support/Antigravity/User/globalStorage/state.vscdb` (VS Code-fork convention) | Likely chat history + agent transcripts in a custom KV table, similar to Cursor's `cursorDiskKV` | **Medium — needs verification** |
| **JSON workspace state** | Likely `User/workspaceStorage/<hash>/` | Per-project conversation state | Medium |
| **Gemini API base-URL override** | Likely respects `GOOGLE_API_KEY` / Vertex AI endpoint config | Live request bodies | Low — depends on whether Antigravity exposes user-side API config |
| **OTEL telemetry** | Unknown | If present, would be ideal | Unknown |

**Choice:** **Antigravity is not in MVP.** Phase 2 begins with a one-day spike on a machine that has Antigravity installed:

1. Locate the on-disk store. (Likely `~/Library/Application Support/<name>/User/globalStorage/state.vscdb`.)
2. Identify the chat-bearing tables and key prefixes.
3. Confirm payloads are plaintext JSON (not encrypted via DPAPI / keychain wrapping).
4. If steps 1–3 succeed, build a collector parallel to the Cursor one — most of the code can be shared. If they fail, fall back to Gemini-API base-URL override or defer.

We do not promise Antigravity coverage until the spike completes.

---

## 6. High-level architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  proxai-gateway (single Python process, launchd LaunchAgent)        │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ Collector plugins (one per agent, polling every 5 min)      │    │
│  │  • claude-code (JSONL watcher)                              │    │
│  │  • cursor      (SQLite watcher)                             │    │
│  │  • codex       (JSONL watcher)                              │    │
│  │  • antigravity (TBD — Phase 2 spike)                        │    │
│  └────────────────────────┬────────────────────────────────────┘    │
│                           ▼                                         │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ Normalizer → OTLP gen_ai semantic conventions               │    │
│  └────────────────────────┬────────────────────────────────────┘    │
│                           ▼                                         │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ Redactor (Stage 1 — gitleaks + auth-header strip)           │    │
│  └────────────────────────┬────────────────────────────────────┘    │
│                           ▼                                         │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ Local buffer (SQLite WAL)                                   │    │
│  └────────────────────────┬────────────────────────────────────┘    │
│                           ▼                                         │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ Uploader: Stage-2 redact → OTLP/HTTP POST → backend         │    │
│  │ Async, batched, exponential backoff, idempotent on UUIDv7   │    │
│  └────────────────────────┬────────────────────────────────────┘    │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ Optional: HTTP proxy server on 127.0.0.1:8788 (fallback     │    │
│  │ path; off by default in MVP)                                │    │
│  └─────────────────────────────────────────────────────────────┘    │
└────────────────────────────────────┬────────────────────────────────┘
                                     ▼
                          ┌─────────────────────┐
                          │  ProxAI backend     │
                          │  (OTLP/HTTP ingest) │
                          └─────────────────────┘
```

### Key shape changes vs. v0.1

- **Collector plugins, not a proxy.** The core abstraction is a `Collector` that polls a source on a 5 min interval and emits normalized records. Each agent gets one. Adding a new agent is "write a collector" — much smaller than "write a provider proxy shim."
- **OTLP everywhere internally.** All collectors emit OTLP-shaped records. The buffer stores them in that shape. The uploader speaks OTLP/HTTP to the backend. No internal schema translation.
- **Single process, async tasks.** Collectors, normalizer, redactor, buffer writer, uploader all share one asyncio event loop. launchd supervises the process.
- **localhost-only HTTP proxy is off by default.** It still exists in the codebase as the fallback path, but the MVP does not require it for any tool.

---

## 7. Tech stack

| Concern | Pick | Why |
|---|---|---|
| Language | Python 3.12+ | Required; modern stdlib (`tomllib`, `asyncio`) |
| Collector framework | Plain asyncio + plugin registry | The 5-min polling cadence makes complex frameworks unnecessary |
| File watching (where useful) | `watchdog` for filesystem events as a "wake the poller now" signal; polling is the source of truth | Belt-and-suspenders |
| SQLite reading | `sqlite3` stdlib + `?mode=ro&immutable=0`; `VACUUM INTO` snapshot for hot DBs | Avoids WAL races |
| Local buffer | `aiosqlite` with WAL on `~/.proxai/buffer.db` | Durable, fast enough |
| Outbound HTTP | `httpx` with HTTP/2, async | OTLP/HTTP, retries, streaming |
| OTLP | `opentelemetry-exporter-otlp-proto-http` | Reference implementation |
| Redaction | `gitleaks` rule corpus → Python regex; `detect-secrets` for Stage 2 | Battle-tested rules |
| CLI | `Typer` | Clean ergonomics for `install`, `status`, `pause`, `uninstall`, `tail` |
| Config | `pydantic-settings` + TOML at `~/.config/proxai-gateway/config.toml` | Type-checked |
| Logging | `structlog` → JSON to `~/Library/Logs/proxai-gateway/` | Greppable |
| Packaging | `uv` + `pyproject.toml` → PyPI | Standard, fast |
| Auto-start | launchd LaunchAgent (per-user) | macOS-correct |
| Optional fallback proxy | `mitmproxy` as a library | Free upgrade path if MITM mode is ever needed |
| Testing | `pytest` + `pytest-asyncio`; golden-file tests for each collector against captured fixture transcripts | Schema-drift detection |

### Tradeoffs worth naming

- **No mitmproxy in MVP hot path.** Big simplification. We drop the dependency from the default install and re-add it only if/when MITM mode ships.
- **Polling, not inotify/FSEvents as primary.** A 5 min poll is robust; FSEvents firing once-per-write would over-trigger. We use `watchdog` only as a wake-up nudge so we drain promptly when a file changes mid-window, but the loop is poll-driven.
- **Single process.** If the uploader becomes heavy (large team, retroactive backfill of months of transcripts), split it into a sidecar. Not premature.

---

## 8. Capture data model (OTLP `gen_ai.*` aligned)

Each captured turn becomes one OTLP **log record** (Anthropic and Codex semantics map cleanly to logs; full conversation = one trace with one span per turn is also valid and we may emit both).

Key fields (subset):

```
gen_ai.system            = "anthropic" | "openai" | "google" | "cursor"
gen_ai.request.model     = "claude-sonnet-4-6" | ...
gen_ai.usage.input_tokens / output_tokens
gen_ai.prompt            = redacted prompt content (role + parts)
gen_ai.completion        = redacted completion content
gen_ai.tool.name / .arguments / .result  (per tool call, redacted)
gen_ai.client            = "claude-code" | "cursor" | "codex" | "antigravity"
gen_ai.client.version    = collector-detected
proxai.capture.id        = UUIDv7  (idempotency key)
proxai.capture.source    = "jsonl" | "sqlite" | "hook" | "otel" | "proxy"
proxai.capture.schema_v  = upstream agent's _v field (when present)
proxai.redaction.stage1.hits = count of patterns that matched
```

Every captured row has a stable UUIDv7. The collector derives it from
`(source_path, source_record_id)` so re-reading the same transcript line
twice produces the same ID and the backend can dedupe.

Local buffer schema (SQLite):

```
captures(
  id              TEXT PRIMARY KEY,    -- UUIDv7 derived from source ref
  ts_captured     INTEGER NOT NULL,    -- when we read it
  agent           TEXT NOT NULL,       -- 'claude-code' | 'cursor' | 'codex' | ...
  source_path     TEXT NOT NULL,       -- transcript file or DB key
  source_ref      TEXT NOT NULL,       -- byte offset / rowid / bubble id
  schema_v        INTEGER,
  payload         BLOB NOT NULL,       -- OTLP-shaped, Stage-1 redacted
  upload_state    INTEGER NOT NULL,    -- 0=pending, 1=uploaded, 2=failed_terminal
  upload_attempts INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT
)
CREATE INDEX captures_pending ON captures(upload_state, ts_captured);
```

---

## 9. Auto-start: launchd plist

Per-user LaunchAgent at `~/Library/LaunchAgents/co.proxai.gateway.plist`, `RunAtLoad=true`, `KeepAlive` only on crash, `ProcessType=Background`. Logs to `~/Library/Logs/proxai-gateway/`. Install via `launchctl bootstrap gui/$(id -u)`. Uninstall via `launchctl bootout`.

`KeepAlive` set so launchd restarts on crash but **not** on clean exit — so `proxai-gateway stop` actually stays stopped until next login.

---

## 10. MVP definition

The MVP captures **Claude Code and Cursor** via their on-disk transcripts, polled every 5 min, normalized to OTLP `gen_ai.*`, redacted, buffered, and uploaded to a backend stub. Codex follows in the same release if its on-machine verification spike succeeds in week 1.

### MVP scope (in)

1. Collector for Claude Code (`~/.claude/projects/**/*.jsonl`, watch + parse + cursor tracking)
2. Collector for Cursor (`~/Library/Application Support/Cursor/User/{global,workspace}Storage/**/state.vscdb`, snapshot + parse `cursorDiskKV` rows by `composerData:` and `bubbleId:` prefix, last-rowid cursor)
3. Stretch: collector for Codex (verify rollout path/format first)
4. OTLP normalization + Stage-1 redaction (`gitleaks` corpus + auth-header strip)
5. SQLite WAL buffer with idempotency on UUIDv7
6. Uploader: OTLP/HTTP, batched, exponential backoff, Stage-2 redaction
7. CLI: `install`, `uninstall`, `start`, `stop`, `status`, `pause`, `resume`, `tail`, `redaction-test <file>`
8. Installer: writes launchd plist; **no shell-profile changes needed** (this is a meaningful UX win over v0.1)
9. `~/.proxai/PAUSED` sentinel kill switch
10. Open-source repo with README, CONTRIBUTING, LICENSE (Apache 2.0), threat model, redaction rules doc, schema-version compatibility table per agent

### Out of MVP (deferred)

- Antigravity (Phase 2 after spike)
- HTTP proxy / base-URL override path (Phase 2, opt-in)
- MITM mode (deprioritized; may never ship)
- Menu-bar UI, local web UI (Phase 3)
- Linux/Windows (Phase 3+)
- OTEL hook reception (`CLAUDE_CODE_ENABLE_TELEMETRY` endpoint) — Phase 2

### Success criteria

- A developer runs `pip install proxai-gateway && proxai-gateway install`, reboots, uses Claude Code and Cursor normally for a day, and the backend has a complete, redacted, OTLP-shaped record of every turn within 5 min of it occurring.
- Zero captured rows contain raw `Authorization` / `x-api-key` headers, raw API keys, or matched `gitleaks` secret patterns. Verified via fuzz test corpus.
- Service survives reboot, sleep/wake, network drop, and 24h backend outage without losing captures (verified by chaos test).
- p99 read overhead per poll cycle < 200 ms on a transcript directory containing one year of sessions.
- Versioned collector parsers handle current schemas; unrecognized `_v` values are stored as raw blobs and uploaded with `proxai.capture.schema_v_unknown=true` so we can extend the parser later.

---

## 11. Roadmap

### Phase 0 — groundwork (week 1–2)
- Repo skeleton, CI, Apache 2.0 license, threat model, SBOM
- Redaction module + fuzz corpus (critical-path dependency)
- Backend ingest contract locked (OTLP/HTTP + idempotency UUIDv7)
- Verification spikes:
  - Claude Code JSONL — already verified on this machine ✓
  - Cursor SQLite — already verified on this machine ✓
  - Codex rollout files — install on a dev machine, confirm path & schema
  - Antigravity — install on a dev machine, locate store, decide go/no-go

### Phase 1 — MVP (week 3–6)
- Claude Code + Cursor collectors
- OTLP normalizer, Stage-1+2 redaction
- SQLite buffer + uploader
- launchd installer + Typer CLI
- Internal dogfooding by ProxAI engineers
- Beta with 1–2 friendly customers

### Phase 2 — coverage (month 3–4)
- Codex collector (assuming Phase 0 spike succeeded)
- Antigravity collector (assuming spike succeeded; otherwise defer)
- Optional HTTP proxy (`ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` / `GOOGLE_API_BASE_URL`) for users who want realtime
- OTEL receiver mode: accept `CLAUDE_CODE_ENABLE_TELEMETRY` and Codex `[telemetry]` exports directly
- Hooks-based collector for Claude Code (settings.json hooks → callback script → buffer)
- Linux support (systemd user unit, identical collector code)

### Phase 3 — polish & enterprise (month 5–6)
- Menu-bar status (rumps)
- Local web UI at `127.0.0.1:8788/_proxai/` for "what got captured today"
- Self-hosted backend mode for security-sensitive customers
- MDM-friendly install package (signed `.pkg`)
- SOC 2 Type 1 evidence collection
- Windows support

### Phase 4 — platform (month 7+)
- Optional MITM mode (signed app, paid Apple Developer Program) — only if a real customer asks
- Team analytics in the cloud product
- Policy mode (block/warn) — separate product surface

---

## 12. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Redaction misses a secret | Medium | Catastrophic | Three-stage redaction with different rule sources; fuzz tests; backend final pass |
| Agent vendor changes on-disk schema | High over time | Medium | `_v` versioned parsers; raw-blob fallback; schema-drift alerts on backend |
| WAL race when reading Cursor's live DB | Medium | Medium | `VACUUM INTO` snapshot before parse; never write to consumer DBs |
| Antigravity store turns out to be encrypted/wrapped | Medium | Medium | Spike before committing; fall back to API-side capture if needed |
| Customer perceives this as spyware | Medium | Catastrophic | Consent-first install; pause sentinel; capture log readable by user; open source |
| Polling misses captures because user closes laptop fast | Low | Low | Poll on launchd `RunAtLoad`; transcripts persist on disk so next-boot poll catches up |
| Apple changes launchd / SQLite WAL semantics | Low per release | Medium | Keep integrations minimal and standard |

---

## 13. Open questions

1. Codex rollout file path & schema — verify in week 1.
2. Antigravity go/no-go — verify in week 1.
3. Backend ingest contract — owned by backend team; lock before MVP code-freeze.
4. Anonymous gateway-self-telemetry (crashes, version) — opt-in at install time.
5. MDM-managed deployment for org rollout — Phase 3.

---

## 14. Recommended immediate next steps

1. Lock OTLP `gen_ai.*` field mapping with the backend team.
2. Build the redaction module + fuzz corpus.
3. Install Codex and Antigravity on a dev machine; run §5.3/§5.4 spikes.
4. Then start the Claude Code and Cursor collectors in parallel.
