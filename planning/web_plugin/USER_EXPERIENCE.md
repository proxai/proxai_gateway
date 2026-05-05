# User Experience — Web Plugin

What the user sees and reads. Mirrors the tone and shape of the desktop gateway's [`USER_EXPERIENCE.md`](../USER_EXPERIENCE.md) — same tone & voice principles apply (terse, helpful, honest; ASCII status markers `[ok]` / `[warn]` / `[err]`; every error tells the user what / why / next).

The extension has three user-visible surfaces: the **first-run page**, the **toolbar popup**, and the **options page**.

---

## 1. First-run page

Triggered automatically the first time the extension is installed. Opens in a new tab.

### Screen

```
ProxAI Web Plugin

You've installed ProxAI Web Plugin. One more step to start capturing.

What ProxAI Web Plugin does:

  - Watches your activity on chatgpt.com, claude.ai, and gemini.google.com
  - For every prompt and response, strips API keys and matched secret patterns
    LOCALLY before any byte leaves your browser
  - Sends the redacted bytes to ProxAI's backend over HTTPS
  - Buffers locally if your network is offline

What it never does:

  - Watch any other site
  - Read your browser passwords, autofill, or cookies on unrelated sites
  - Capture anything while paused

  [API key:                                                         ]
  Get a key at: https://proxai.co/dashboard/api-keys

  [Save and start capturing]
```

After the user pastes a key and clicks the button:

```
[ok] Key validated. Signed in as alice@example.com.
[ok] Test capture sent to ProxAI.

You're all set.

Pin the extension in the toolbar so you can pause it any time:
Click the puzzle-piece icon in Chrome's toolbar -> "Pin" next to ProxAI.
```

If validation fails:

```
[err] That API key isn't valid.

Things to check:
  - Did you copy the entire key, including the prefix (e.g. pxk_live_...)?
  - Has the key been revoked from the dashboard?

Get a key:  https://proxai.co/dashboard/api-keys
```

---

## 2. Toolbar popup

Click the extension icon in the browser toolbar. Compact panel.

### Active

```
ProxAI Web Plugin     [active]

Captures today:    47
Last capture:      2 min ago
Pending upload:    0

Sites:
  [x] chatgpt.com
  [x] claude.ai
  [x] gemini.google.com

[Pause capturing]                   [Open dashboard ↗]

Signed in as alice@example.com
```

The site checkboxes toggle per-host capture instantly (writes to `chrome.storage.local`, picked up on the next request).

### Paused

```
ProxAI Web Plugin     [paused]

Reason:            "client demo"
Paused since:      14:42 (1 hour ago)
Pending upload:    3

[Resume capturing]                  [Open dashboard ↗]
```

### Degraded

When something is off but the extension is still trying.

```
ProxAI Web Plugin     [degraded]

Issue: Backend rejecting uploads since 14:22 (37 min ago)
        last error: "402 Payment Required"

To resolve:        https://proxai.co/dashboard/billing

Captures buffered: 12 (will retry on next upload cycle)

[Pause capturing]                   [Open dashboard ↗]
```

The badge text on the extension icon shows pending-upload count when nonzero (e.g., `12` when offline-buffered captures are waiting).

---

## 3. Options page

Opened via `chrome://extensions` → "Details" → "Extension options", or via a link from the popup.

### Sections

**Account**
- Current API key (masked, with "Replace key" button)
- Signed in as: `alice@example.com`
- "Sign out" button (clears local config; same as uninstall + reinstall but without the Web Store roundtrip)

**Sites**
- Per-host enable/disable toggles for the three target sites (same as popup, more space)
- "Add custom site" — Phase 2 (for self-hosted LLM frontends like LibreChat, Open WebUI)

**Privacy**
- Link to the redaction-rules documentation
- "Test redaction" — paste arbitrary text, see what would be redacted client-side. Equivalent to the desktop's `proxai-gateway redaction-test`.

**Diagnostics**
- Extension version, last update
- Last upload, last error
- "Copy diagnostic dump" button (safe to share — no captured content, no API key)

---

## 4. Pause UX

Pause is one click in the popup. Effects:

- Sentinel flag in `chrome.storage.local` is set.
- The extension icon's badge changes to a paused indicator (gray icon, no badge text).
- New requests are observed but their captured envelopes are dropped before redaction (so we don't even spend CPU on them).
- The popup shows the paused state with the resume action prominent.

Resume reverses it. Same one-click.

---

## 5. Update behavior

Web Store auto-updates extensions silently. The user doesn't see "update available" prompts.

If a critical update is needed (e.g., new redaction rule for a high-impact secret format), it propagates within hours of release. This is fundamentally different from the desktop gateway's manual `npm install --upgrade` and is one of the architecture's strongest properties.

The popup surfaces an `[update available]` indicator only if the local extension is somehow stuck on an old version (e.g., the user disabled auto-update at the browser level).

---

## 6. Uninstall

The user uninstalls via Chrome's extension management page (`chrome://extensions`). On uninstall, an `onUninstalled` callback (if registered before uninstall via `chrome.runtime.setUninstallURL`) opens a brief feedback URL:

```
https://proxai.co/uninstall-feedback?v=<extension-version>
```

The feedback page is optional and not required for the user to complete uninstallation. No data is sent unless the user explicitly clicks "Submit feedback".

Local storage and IndexedDB are cleaned up by the browser automatically as part of uninstall.

---

## 7. Tone & voice

Same as the desktop gateway's `USER_EXPERIENCE.md` §1:

- **Terse.** No marketing language. No exclamation points.
- **Helpful.** Every error has what / why / next-action in three lines.
- **Honest.** Surface degradation; don't hide failures behind a green badge.
- ASCII markers (`[ok]`, `[warn]`, `[err]`) — colorize when a TTY/UI permits, but the markers convey state without color.
- The bar is set by `gh`, `tailscale`, `stripe` CLIs and a few well-designed extensions: 1Password, Tailscale (their tray UI), Vimium.

The web plugin has more visual surface than the CLI (icons, badges, popup layout), but the writing rules are unchanged.
