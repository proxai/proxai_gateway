# ProxAI Gateway

A macOS background service that captures the LLM activity of your coding agents — Claude Code, Cursor, and Codex — and ships it to your ProxAI dashboard.

It reads each agent's local transcript files directly. **No network proxy. No root certificate. No traffic interception.** Secret redaction runs on your laptop before any byte leaves it.

Open source (Apache 2.0).

---

## Quickstart

```sh
npm install -g @proxai/gateway
proxai-gateway install
proxai-gateway status
```

`install` is interactive: it asks for your ProxAI API key, walks you through macOS Full Disk Access if needed, and registers a launchd LaunchAgent so the service starts at every login.

To stop capturing for a meeting:

```sh
proxai-gateway pause
proxai-gateway resume
```

To remove it entirely:

```sh
proxai-gateway uninstall
npm uninstall -g @proxai/gateway
```

---

## What it captures

| Captured | Not captured |
|---|---|
| Your prompts to coding agents | Provider API keys (redacted before storage) |
| Assistant responses (text, tool calls, tool results) | OS keychain, password manager |
| Per-turn token counts and timestamps | Other apps' data |
| Session and workspace metadata | Anything outside `~/.claude/`, `~/.codex/`, Cursor's data dir |
| Git branch / repo for the session | Files you didn't open in a coding agent |

The exact paths are listed in [`03_FLUSHING_ALGORITHM.md`](03_FLUSHING_ALGORITHM.md) §5–§7. Anything not on that list, the gateway never reads.

---

## Privacy and control

Designed to be auditable, not asked-to-be-trusted.

- **Three-stage secret redaction**, all client-side. The first two stages run in the gateway before captures are persisted; the third runs on the backend. Rules are based on the open-source `gitleaks` and `detect-secrets` corpora.
- **Verify what gets redacted** on any file:
  ```sh
  proxai-gateway redaction-test path/to/file.jsonl
  ```
- **Pause instantly** without uninstalling — `proxai-gateway pause`, or just touch `~/.proxai/PAUSED`.
- **Local capture log** at `~/Library/Logs/proxai-gateway/` — every captured record is recorded, in your file system, before it goes anywhere.
- **No proxy, no root CA**, ever. The gateway only reads files; it does not intercept network traffic.
- **Open source.** Audit any line.

If something looks wrong, run `proxai-gateway doctor` to dump diagnostic state (safe to share — no captured content, no API key).

---

## How it works

Every five minutes, the gateway:

1. Checks the modification time of each agent's transcript files. If nothing changed, skip.
2. For changed files, reads only the new bytes (JSONL append, or new SQLite rows).
3. Applies redaction rules locally to strip API keys, auth tokens, and known secret formats.
4. Buffers the redacted bytes in a local SQLite database (`~/.proxai/buffer.db`) until upload.
5. POSTs to the ProxAI backend over HTTPS. Retries with exponential backoff on failure.

```
   coding agents             gateway (this repo)            ProxAI backend
   ──────────────            ───────────────────            ──────────────
   Claude Code   ┐
   Cursor        ┼──▶  read transcripts ──▶ redact ──▶ buffer ──▶ HTTPS POST
   Codex         ┘
```

Parsing into structured records (the `CallRecord` shape) happens on the backend, not on your laptop. Schema fixes ship server-side; the laptop binary stays small and stable.

Total CPU per hour while you're working: under five seconds. The gateway will not appear in Activity Monitor's "Apps using significant energy" list.

---

## Documentation

| Doc | What's in it |
|---|---|
| [`01_INTRO.md`](01_INTRO.md) | Overall architecture and MVP scope |
| [`02_CLI_DESIGN.md`](02_CLI_DESIGN.md) | Full CLI command reference |
| [`03_FLUSHING_ALGORITHM.md`](03_FLUSHING_ALGORITHM.md) | Per-agent capture, watermarks, and the backend-upload DTO contract |
| [`04_AGENT_CALL_RECORD.md`](04_AGENT_CALL_RECORD.md) | The typed record the backend produces from raw bytes |
| [`05_AGENT_CALL_RECORD_MAPPING.md`](05_AGENT_CALL_RECORD_MAPPING.md) | Backend-side reference: how raw fields map to `AgentCallRecord` |
| [`06_USER_EXPERIENCE.md`](06_USER_EXPERIENCE.md) | What the user sees and how messages should read |
| [`07_MACOS_MVP.md`](07_MACOS_MVP.md) | macOS implementation details (launchd, file watching, gotchas) |

If you're a contributor reading these in order: `README.md` → `01_INTRO.md` → `03_FLUSHING_ALGORITHM.md` → `04_AGENT_CALL_RECORD.md` → the rest as needed.

---

## Status

| | |
|---|---|
| Platforms | macOS (Apple Silicon and Intel) |
| Agents | Claude Code, Cursor, Codex |
| Distribution | npm registry as `@proxai/gateway` |
| License | Apache 2.0 |

Antigravity, Linux, Windows, menu-bar tray, native `.pkg` installer, signed code, optional HTTP-proxy capture mode — all post-MVP. See [`01_INTRO.md`](01_INTRO.md) §9 for the roadmap.

---

## Frequently asked

**Is this a keylogger?**
No. The gateway reads only the transcript files that the coding agents themselves write to disk — files you can `cat` yourself. It does not intercept keystrokes, network traffic, or any other process's memory.

**Can I see exactly what's being uploaded?**
Yes. Run `proxai-gateway tail` to see what's been captured recently, or open `~/Library/Logs/proxai-gateway/structured.log` directly. Run `proxai-gateway redaction-test <file>` to see what redaction does to any file.

**What if I paste an API key into a coding agent?**
The redaction layer scans every captured record for known secret formats (Anthropic, OpenAI, Google, AWS, GitHub PATs, Stripe keys, JWTs, GCP service accounts, and the rest of the `gitleaks` corpus). Matches are replaced with `[REDACTED:type]` before the record is buffered, let alone uploaded. The backend re-redacts on receive as defense in depth. If a redaction rule misses, please open an issue.

**Does this slow my machine down?**
Very unlikely to be detectable. The gateway uses `mtime` checks before reading anything, and a full poll cycle is under 200 ms. Sustained CPU is under five seconds per hour.

**My company requires Full Disk Access pre-approval.** The installer probes for FDA at install time and prints clear instructions if it's needed. For MDM-managed deployments, see the Phase 3 roadmap in [`01_INTRO.md`](01_INTRO.md).

**Where does my data go?**
By default, to `nest.proxai.co`. Self-hosted backend mode is on the Phase 3 roadmap.

---

## Contributing

The repository follows the conventions of the wider ProxAI codebase. See `CONTRIBUTING.md` (forthcoming).

For bug reports, redaction-rule additions, or feature ideas, open an issue.

---

## License

[Apache 2.0](LICENSE).
