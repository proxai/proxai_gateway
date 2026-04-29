# Browser MVP — Extension Implementation Plan

How the extension actually runs in the browser: manifest, the three-component architecture, MV3 quirks, distribution.

---

## 1. The Manifest V3 constraint that shapes everything

The `webRequest` API in MV3 cannot access request or response **bodies** — only headers and URLs. Google removed this on purpose. So we cannot capture LLM traffic by simply listening on `chatgpt.com/backend-api/*` from a background script.

The path that does work: **inject a script into the page's main world** that monkey-patches `window.fetch` and `window.XMLHttpRequest`. Those patches execute in the page's own JS context, where bodies are visible. Captured calls are forwarded to the extension's service worker via `window.postMessage` → content script → `chrome.runtime.sendMessage`.

This single constraint is why we have three components instead of one. The rest of the architecture follows from it.

---

## 2. The three components

```
┌────────────────────────────────────────────────────────────┐
│  Page (chatgpt.com / claude.ai / gemini.google.com)        │
│                                                            │
│   page-injected.js  (world: "MAIN")                        │
│   • patches window.fetch and XMLHttpRequest                │
│   • on captured call: window.postMessage(envelope)         │
└────────────────────────┬───────────────────────────────────┘
                         ▼
┌────────────────────────────────────────────────────────────┐
│  content-bridge.js  (world: "ISOLATED")                    │
│   • addEventListener('message', forwardToServiceWorker)    │
└────────────────────────┬───────────────────────────────────┘
                         ▼
┌────────────────────────────────────────────────────────────┐
│  service-worker.js  (background)                           │
│   • Stage 1 + Stage 2 redaction                            │
│   • IndexedDB buffer                                       │
│   • HTTPS upload to nest.proxai.co/v1/raw_records          │
│   • chrome.alarms keep-alive every 1 min                   │
└────────────────────────────────────────────────────────────┘
```

### Why this exact split

| Component | Why it exists |
|---|---|
| **page-injected.js (main world)** | The only context where `window.fetch` can be wrapped to see bodies. |
| **content-bridge.js (isolated world)** | The bridge. Has access to `chrome.*` APIs that main-world doesn't. Forwards messages from page to service worker. |
| **service-worker.js (background)** | The only context that can do CORS-allowed cross-origin uploads, talk to `chrome.storage`, and persist to IndexedDB. |

### `manifest.json` essentials

```json
{
  "manifest_version": 3,
  "name": "ProxAI Web Plugin",
  "version": "0.1.0",
  "host_permissions": [
    "https://chatgpt.com/*",
    "https://claude.ai/*",
    "https://gemini.google.com/*",
    "https://nest.proxai.co/*"
  ],
  "permissions": ["storage", "alarms"],
  "background": { "service_worker": "service-worker.js", "type": "module" },
  "content_scripts": [
    {
      "matches": ["https://chatgpt.com/*", "https://claude.ai/*", "https://gemini.google.com/*"],
      "js": ["page-injected.js"],
      "world": "MAIN",
      "run_at": "document_start"
    },
    {
      "matches": ["https://chatgpt.com/*", "https://claude.ai/*", "https://gemini.google.com/*"],
      "js": ["content-bridge.js"],
      "world": "ISOLATED",
      "run_at": "document_start"
    }
  ],
  "action": { "default_popup": "popup.html" },
  "options_page": "options.html"
}
```

`run_at: document_start` is critical — the patch must be in place before the SPA's bundle initializes its own `fetch` reference.

---

## 3. Service-worker lifecycle

MV3 service workers are terminated after ~30s of inactivity. Implications:

- **All state in IndexedDB or `chrome.storage`.** Never assume in-memory state survives.
- **`chrome.alarms.create("upload-drain", { periodInMinutes: 1 })`** wakes the worker periodically to drain the upload queue.
- **Every postMessage from a content script wakes the worker.** The forwarded capture event re-creates any in-memory context the worker needs from persisted state.

This is the browser equivalent of "polling vs FSEvents" in the desktop product — the worker can't run a live event loop, so we wake it on alarm + on inbound message.

---

## 4. Tab lifecycle & streaming

A tab can close mid-stream. Handling:

- The patched `fetch` returns a tee'd `ReadableStream` to the page (so the user sees real-time streaming) while we accumulate a copy.
- On stream completion (`reader.read()` returns `{done: true}`): full record sent to service worker, marked complete.
- On `beforeunload` while a stream is mid-flight: send the partial accumulated response, marked `partial: true` so the backend knows. Better partial than nothing.

---

## 5. CORS

Cross-origin POSTs to `nest.proxai.co` from the service worker work because we declare it in `host_permissions`. The same calls from a content script would not. Always upload from the service worker.

---

## 6. Tech stack

| Concern | Pick |
|---|---|
| Language | TypeScript |
| Bundler | Vite + `@crxjs/vite-plugin` |
| Manifest | MV3 |
| Buffer | IndexedDB via `idb` |
| Config | `chrome.storage.local` |
| Redaction | Shared `@proxai/redaction-rules` package (same corpus as desktop gateway) |
| Upload | `fetch` from service worker |
| Test | `vitest` (unit), Playwright (E2E with recorded fixtures) |
| Package manager | `pnpm` |

---

## 7. Distribution

| Store | MVP? |
|---|---|
| **Chrome Web Store** | Yes (largest user base, required for managed enterprise install) |
| **Edge Add-ons** | Yes — same MV3 manifest works |
| **Firefox Add-ons** | Phase 2 (manifest tweaks; Firefox webRequest is stricter) |
| **Safari** | Phase 4 / never (requires native macOS app wrapper) |
| Unpacked sideload | Dev only |

Web Store reviews take 2–7 days for first submission. Auto-update is hours-fast once approved — the stale-binary risk is much smaller here than for the desktop gateway.

---

## 8. Web Store submission requirements

Beyond writing the code, shipping to the Web Store needs the following. The engineer who finishes the extension can't submit without these.

| Item | Notes |
|---|---|
| **Privacy policy URL** | Mandatory; submission form rejects without one. ProxAI's published privacy policy at `proxai.co/privacy` needs a clearly-titled section covering what the extension captures, how it's redacted, and where it's sent. |
| **Single-purpose statement** | Web Store policy is strict. Use specific phrasing: "Captures LLM activity on chatgpt.com, claude.ai, and gemini.google.com for the user's ProxAI account analytics." Vague phrasing ("AI tools utility") gets rejected. |
| **Per-permission justification** | Required for every `host_permissions` and `permissions` entry. Examples to write: `https://chatgpt.com/*` → "Required to capture the user's ChatGPT conversations for analytics." `storage` → "Stores the user's API key and capture buffer." `alarms` → "Periodically wakes the service worker to upload buffered captures." |
| **Listing copy** | Name (45 char), short description (132 char), full description (16,000 char). Use the full description for transparency about what's captured and what's not. |
| **Category** | "Developer Tools" or "Workflow & Planning" |
| **Screenshots** | 1280×800 or 640×400, at least one, up to five. Suggest: popup screenshot, options page, first-run page. |
| **Promotional tiles** | 440×280 (small, recommended), 920×680 (large), 1400×560 (marquee — improves discovery). |
| **Distribution geography** | Default to all regions; revisit if compliance concerns arise. |
| **Trader / non-trader status** | ProxAI is a business with paying customers — declare as **trader** when prompted. |

The privacy-policy section is the longest-lead item and worth starting before the code is finished.

---

## 9. Browser gotchas

Parallel to `MACOS_MVP.md` §7 — the list of browser-side surprises that will trip an engineer at least once.

| Gotcha | What we do |
|---|---|
| **CSP and `world: "MAIN"`** | Extension main-world scripts are exempt from page CSP — they're loaded by the browser's extension subsystem, not parsed from HTML. This is why our injection works on Gemini despite its strict CSP. Documented here so an engineer doesn't second-guess it during debugging. |
| **Service worker termination (~30s idle)** | Already covered in §3. Restated: every piece of state must be in IndexedDB or `chrome.storage`. |
| **IndexedDB quota** | Chrome allows roughly 60% of free disk space, evicts under pressure. We soft-cap our buffer at a small fraction of that (e.g., 50 MB) and FIFO-drop oldest captures with a telemetry event when triggered. |
| **Update during a live stream** | When an extension auto-update lands mid-stream, Chrome terminates the old service worker and starts the new one. In-flight `fetch` hooks in the page keep working until the page reloads; the mid-flight capture's reassembly may be lost (since it lived in the old SW's memory before being persisted). Acceptable for MVP. |
| **Dev-mode reload** | The `chrome://extensions` Reload button reloads the manifest and SW but does NOT re-inject content scripts into already-open tabs. Reload the target tab too. (Trips everyone the first time.) |
| **Permission dialog copy** | Chrome auto-generates this from the manifest's `host_permissions`. Users see literally "Read and change your data on chatgpt.com, claude.ai, gemini.google.com". We can't rephrase it; we can shape it by being precise about which hosts we list. |
| **Browser restart** | Alarms and IndexedDB persist across restart. In-memory state does not. Same effective behavior as SW termination. |
| **Cross-origin from service worker** | Allowed because `nest.proxai.co` is in `host_permissions`. Same call from a content script would not work. Always upload from the SW. |
| **Hot-reload during development** | Use `vite-plugin-web-extension` (or `@crxjs/vite-plugin`) HMR; falling back to manual reload is fine for the MVP. |
| **Multiple browser profiles** | Each profile is a separate install with its own `install_id`. A user with three Chrome profiles produces three identities. Acceptable; document it in the dashboard. |

---

## 10. Testing the architecture before committing

Before any feature work: write a 50-line throwaway test extension that hooks `fetch` on all three sites and logs captured request URLs + body sizes to the console. Sideload via `chrome://extensions` → Developer mode → "Load unpacked". Use the three sites for 5 minutes. Verify all captures appear.

If the test extension's logs match what shows in the DevTools Network tab on the same sites, the architecture is verified end-to-end. If anything is missing, debug before writing redaction or buffer code.

This is the equivalent of the desktop product's "verify on this machine" spike that we did for Claude Code, Cursor, and Codex.
