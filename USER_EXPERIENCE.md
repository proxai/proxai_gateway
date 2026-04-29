# User Experience — `proxai-gateway`

The user-visible flows and on-screen copy. This complements [`CLI_DESIGN.md`](CLI_DESIGN.md) — that doc is the engineer's command reference; this one is what the user actually sees and reads. The engineer building any user-visible message implements against the copy specified here unless they have a documented reason to deviate.

---

## 1. Tone & voice

Every line a user sees should pass three tests:

1. **Terse.** Short sentences. No marketing language inside the CLI. No "awesome", no "successfully", no exclamation points.
2. **Helpful.** Every error message tells the user **what happened, why it matters, and what to do next**. Three lines is the budget.
3. **Honest.** If something is degraded, say it's degraded. Never hide a failed upload behind a green checkmark.

**Avoid**: emoji (the CLI has no emoji), Title Case headers, "We", marketing phrasing. The CLI is a tool, not a brand voice.

**Use**: lowercase status words (`active`, `paused`, `degraded`), specific numbers (`47 records, 12 sessions`), specific time (`2 min ago`, never `just now`), explicit next commands (`run: proxai-gateway resume`).

ASCII status markers are: `[ok]`, `[warn]`, `[err]`, `[skip]`. Used sparingly, only where state distinction matters.

---

## 2. Install flow

The `proxai-gateway install` command is the only flow that's "interactive" in the modern sense. It must be calm, never anxious. Each screen shows what's about to happen before it happens.

### Screen 1 — Welcome

```
ProxAI Gateway 0.4.2

This installs ProxAI Gateway as a background service that captures your
coding-agent activity (Claude Code, Cursor, Codex) for analytics in your
ProxAI dashboard.

Press Enter to continue, or Ctrl-C to cancel.
```

### Screen 2 — Consent

```
What ProxAI Gateway will read on your machine:

  ~/.claude/projects/                          (Claude Code transcripts)
  ~/.codex/sessions/                           (Codex CLI rollouts)
  ~/Library/Application Support/Cursor/User/   (Cursor conversation data)

For each captured turn:

  - API keys, auth tokens, and matched secret patterns are stripped LOCALLY
    before anything is stored or uploaded.
  - The redacted bytes are sent to ProxAI's backend over HTTPS.
  - If your network is offline, captures are buffered locally and retried.

What it never does:

  - Read any other directory on your machine
  - Install a network proxy or root certificate
  - Read your OS keychain, password manager, or browser data

You can:
  - Run "proxai-gateway pause" at any time to stop capturing instantly
  - Run "proxai-gateway redaction-test <file>" to see what gets redacted
  - Run "proxai-gateway uninstall" to remove the service

Do you agree and want to continue? [y/N]:
```

The `[y/N]` capitalization signals that the safe default is "no". Treat any input other than `y`/`yes` (case-insensitive) as decline.

### Screen 3 — API key

```
ProxAI API key

Get a key at: https://proxai.co/dashboard/api-keys

Any key from your account works (existing SDK key, or a new one).

API key: [hidden input]
```

The input is hidden (no echo). Paste-friendly. After validation:

```
[ok] Key validated. Signed in as alice@example.com.
```

If invalid, see [§7 errors / Invalid API key](#invalid-api-key).

### Screen 4 — Full Disk Access probe

If FDA is already granted (Cursor's `state.vscdb` is readable):

```
[ok] Full Disk Access is granted. Cursor capture will work.
```

If FDA is missing:

```
[warn] Full Disk Access is required to read Cursor's data.

Without it, Claude Code and Codex capture will work, but Cursor capture
will fail silently in the background.

To grant it:
  1. Open System Settings -> Privacy & Security -> Full Disk Access
  2. Click "+", add: /usr/local/bin/node
  3. Toggle the switch ON

  [Open System Settings now]   [Skip - I'll do it later]
```

If the user picks "Open System Settings now", the CLI runs:

```sh
open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
```

…then waits for the user to come back and press Enter. On re-probe success: `[ok] Full Disk Access granted. Continuing.`

If they pick "Skip", install proceeds with a warning recorded for `status` to surface later.

### Screen 5 — Smoke test

```
Sending a test record to ProxAI...
[ok] Test record received.
```

On failure:

```
[err] Couldn't reach ProxAI's backend.

We tried: https://nest.proxai.co/v1/health
Status:   timeout after 10 seconds

The service is installed but the first upload failed. Captures will
buffer locally and retry automatically.

To retry now:    proxai-gateway start
To diagnose:     proxai-gateway doctor
```

### Screen 6 — Done

```
ProxAI Gateway is installed and running.

  Status:        proxai-gateway status
  Pause/resume:  proxai-gateway pause / resume
  Logs:          ~/Library/Logs/proxai-gateway/
  Dashboard:     https://proxai.co/dashboard

Auto-start on every login: enabled.

Use Claude Code, Cursor, or Codex as you normally would. Captures
will appear in your dashboard within 5 minutes.
```

That's the full install flow: welcome, consent, key, FDA, smoke, summary. Six screens. Cancellable at every prompt with Ctrl-C, leaves a clean state on cancel.

---

## 3. `status` output

The `status` command must answer one question: *is this thing working?* The output fits on one screen at any reasonable terminal size. There are four states with distinct copy.

### Active

```
ProxAI Gateway 0.4.2 - active

Last upload:        2 min ago (47 records)
Captures pending:   3
Captures today:     312
Backend:            reachable (nest.proxai.co)

Sources:
  claude-code   [ok]   12 sessions tracked, last activity 4 min ago
  cursor        [ok]   2 workspaces tracked, last activity 17 min ago
  codex         [ok]   1 session tracked, last activity 1 min ago

Health:
  Full Disk Access:    granted
  Buffer:              3 pending / 500 MB cap (0.1% used)
  Binary age:          12 days
  Redaction self-test: passing (last run 4 min ago)
```

### Paused

```
ProxAI Gateway 0.4.2 - paused

Reason:             "client demo"
Paused since:       2026-04-28 13:42 -08:00 (3 hours ago)
Pending captures:   8 (will upload on resume)

To resume:  proxai-gateway resume
```

### Stopped

```
ProxAI Gateway 0.4.2 - stopped

The launchd service is not loaded. The gateway is not capturing or uploading.

Pending captures (in local buffer): 12

To start:    proxai-gateway start
To uninstall: proxai-gateway uninstall
```

### Degraded

When something is off but the daemon is still running. The first line states the issue plainly; the rest of the output is the same as Active (so the user can see what's working and what isn't).

```
ProxAI Gateway 0.4.2 - degraded

Issue: Full Disk Access not granted; Cursor capture is failing.

To fix:
  1. Open System Settings -> Privacy & Security -> Full Disk Access
  2. Add and enable: /usr/local/bin/node
  3. Captures will resume on the next poll cycle (within 5 min)

Last upload:        17 min ago (Claude Code + Codex working normally)
Captures pending:   12
Captures today:     287

Sources:
  claude-code   [ok]    8 sessions tracked, last activity 6 min ago
  cursor        [err]   FDA not granted - cannot read state.vscdb
  codex         [ok]    1 session tracked, last activity 3 min ago

Health:
  Full Disk Access:    NOT GRANTED
  Buffer:              12 pending / 500 MB cap (0.4% used)
  Binary age:          12 days
  Redaction self-test: passing (last run 14 min ago)
```

### `--json` output

Every state has a stable JSON equivalent at `proxai-gateway status --json`. Field names match the human output one-to-one (`state`, `last_upload_ago_sec`, `captures_pending`, etc.). Stable across versions; new fields can be added but never removed without a major version bump.

---

## 4. Pause / resume

### `pause`

```
$ proxai-gateway pause
[ok] Paused. The daemon will skip captures until you resume.
```

With `--reason "lunch"`:

```
$ proxai-gateway pause --reason "lunch"
[ok] Paused (reason: lunch). The daemon will skip captures until you resume.
```

If already paused:

```
$ proxai-gateway pause
[skip] Already paused since 13:42 (reason: client demo).
```

### `resume`

```
$ proxai-gateway resume
[ok] Resumed. Captures will continue on the next poll cycle (within 5 min).
```

If not paused:

```
$ proxai-gateway resume
[skip] Not paused. Nothing to do.
```

---

## 5. Update prompts

There is no auto-update prompt UI in MVP. The mechanism is `npm install -g @proxai/gateway@latest`. But the gateway must surface that it's getting old.

### Inside `status` — fresh

```
  Binary age:  12 days
```

### Inside `status` — over 90 days

```
  Binary age:  93 days  [warn]   Update recommended:  npm install -g @proxai/gateway@latest
```

### Inside `status` — over 180 days (auto-paused)

```
  Binary age:  187 days  [err]   AUTO-PAUSED for safety. Update to resume:
                                 npm install -g @proxai/gateway@latest
```

When the daemon auto-pauses for staleness, the structured log records it and a one-time notification is logged at WARN level so it shows in `proxai-gateway tail`:

```
{"level":"warn","msg":"binary auto-paused due to age","binary_age_days":187,"threshold_days":180}
```

Phase 2 will surface this through the menu-bar tray. For MVP, the user sees it via `status` only.

---

## 6. Uninstall

### Confirmation prompt

```
$ proxai-gateway uninstall

This will:
  - Unload the launchd service (capturing stops immediately)
  - Remove ~/Library/LaunchAgents/co.proxai.gateway.plist

Your config, captures buffer, and logs will be kept at ~/.proxai/ in case
you reinstall. Use --purge to remove them too.

Continue? [y/N]:
```

With `--purge`:

```
$ proxai-gateway uninstall --purge

This will:
  - Unload the launchd service (capturing stops immediately)
  - Remove ~/Library/LaunchAgents/co.proxai.gateway.plist
  - Delete ~/.proxai/ (config, buffer, logs - 12 MB)

This cannot be undone. Continue? [y/N]:
```

### Done

```
[ok] ProxAI Gateway uninstalled.

To remove the package as well:
  npm uninstall -g @proxai/gateway
```

---

## 7. Error catalog

Every common error gets a specified message: **what happened, why it happened, what to do next**. Three lines max. The exit code is in [`CLI_DESIGN.md`](CLI_DESIGN.md) §8.

### Invalid API key

```
[err] That API key isn't valid.

Things to check:
  - Did you copy the entire key, including the prefix (e.g. pxk_live_...)?
  - Has the key been revoked from the dashboard?
  - Are you using a key from the right account?

Get a key:  https://proxai.co/dashboard/api-keys
```

### Backend unreachable during install

```
[err] Couldn't reach ProxAI's backend.

We tried: https://nest.proxai.co/v1/health
Status:   timeout after 10s

If you're on a VPN or corporate network, confirm proxai.co is reachable.

To retry:    proxai-gateway install
To diagnose: proxai-gateway doctor
```

### Backend rejecting uploads (steady state)

Surfaces in `status` and `tail`, not as an interactive error. In `status`:

```
Backend:  rejecting uploads since 14:22 (3 hours ago)
          last error: "402 Payment Required: subscription expired"

To resolve:  visit https://proxai.co/dashboard/billing
```

### Full Disk Access missing (steady state)

Already covered in §3 (Degraded status). The CLI does not nag the user repeatedly; the warning lives in `status` until resolved.

### Disk full / buffer cap exceeded

```
[warn] Local buffer is at 92% of cap (459 MB / 500 MB).

This means uploads to ProxAI have been failing for a while.

Recent failures:
  - 12:42  502 Bad Gateway
  - 12:48  502 Bad Gateway
  - 12:54  connection reset

The oldest 10% of buffered captures will be dropped if the buffer fills.

To diagnose:  proxai-gateway doctor
To raise cap: edit ~/.proxai/config.toml -> [capture].buffer_max_bytes
```

### Malformed JSONL line in agent transcript

This is a daemon-internal warning, never user-interactive. Logged at WARN level:

```
{"level":"warn","msg":"unparseable jsonl line","source":"claude-code","file":"....jsonl","line":4192,"reason":"invalid json","skipped":true}
```

The line is skipped, the cursor advances past it. Never an exit error.

### SQLite WAL race / corruption on a consumer DB

```
{"level":"warn","msg":"could not snapshot consumer db","source":"cursor","path":"...state.vscdb","reason":"database is locked","retry_in_sec":60}
```

Retried on the next poll. If it keeps failing, surfaces in `status` Health.

### `launchctl bootstrap` failed during install

```
[err] Couldn't register the auto-start service with launchd.

Command:  launchctl bootstrap gui/501 ~/Library/LaunchAgents/co.proxai.gateway.plist
Error:    Bootstrap failed: 5: Input/output error

This usually means an old launch agent is conflicting. To clean up:

  launchctl bootout gui/501/co.proxai.gateway 2>/dev/null
  proxai-gateway install

If the problem persists:  proxai-gateway doctor
```

### Already-installed conflict

```
[skip] ProxAI Gateway is already installed and running on this machine.

Reconciling configuration...
[ok] Configuration unchanged.
[ok] launchd service running.

To force a fresh install:  proxai-gateway uninstall && proxai-gateway install
```

### `--non-interactive` set but a prompt was required

```
[err] Interactive input was required, but --non-interactive was set.

Required input: ProxAI API key

To proceed:  pass --api-key <key> as a flag, or omit --non-interactive.
```

### Permission denied reading user dir

```
{"level":"error","msg":"permission denied","source":"cursor","path":"~/Library/Application Support/Cursor/User/globalStorage/state.vscdb","reason":"EACCES","action":"surfaced as FDA missing in status"}
```

User-visible result: source shows `[err]` in `status` output with the FDA-missing remediation.

---

## 8. Style notes for engineers

Read these once before writing any user-visible string.

- **Surface state in the noun, not the verb.** `Paused` not `Currently paused`. `Active` not `Running normally`.
- **Quote user-supplied strings.** Reasons, file paths, model names — always quoted.
- **Use ISO 8601 + offset for timestamps** in CLI output (`2026-04-28 13:42 -08:00`), with a relative form alongside (`3 hours ago`) for human glance.
- **Use specific numbers.** `47 records` beats `several records`. `2 min ago` beats `recently`.
- **Always end errors with the next action.** A user who sees `[err] X failed` should not have to guess what to do next.
- **Avoid yes/no questions where the answer matters.** `Continue? [y/N]` is fine for confirmation. Don't write `Do you want to retry?` mid-flow without a clear escape.
- **Never use color as the only signal.** `[ok]` / `[warn]` / `[err]` are explicit so the output is meaningful in pipes, logs, and screen readers. Colorize when a TTY is detected, but the markers convey the same information without color.
- **Don't lie.** If the smoke-test fails, don't say `[ok] Installed`. Say what happened.
- **Don't apologize.** "Sorry, that didn't work" is noise. State the failure and the fix.
- **Don't lecture.** A user who triggers an error doesn't need a paragraph about what they should have done. Three lines: what, why, next.
- **Internationalization** is out of MVP scope. All copy is en-US. If we add localization later, all strings move to a centralized message catalog.

When in doubt, look at how `gh`, `tailscale`, and `stripe` CLIs handle equivalent situations. Those three are the bar.
