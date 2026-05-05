# ProxAI Web Plugin — Design

**Status:** Draft v0.2 (simplified)
**Owner:** ProxAI
**Last updated:** 2026-04-29

A browser extension that captures employees' LLM activity on the major web chat surfaces — `chatgpt.com`, `claude.ai`, `gemini.google.com` — and ships it to the same `proxai_nest` backend the desktop gateway uses. Same auth, same redaction approach, same `CallRecord` shape on the backend.

This doc lives under `proxai_gateway/web_plugin/` for now because the two products share the ingest contract, the redaction corpus, and the API key. Will move to its own repo once those interfaces stabilize.

---

## 1. Problem

The desktop gateway captures coding-agent activity (Claude Code, Cursor, Codex). It misses everything that happens in the browser — ChatGPT for research, Claude for drafting, Gemini for analysis. For ProxAI's employer-facing analytics product, that's a major surface to leave uncovered.

Same job as the gateway, different mechanism: capture LLM interactions, redact secrets locally, ship to the backend.

---

## 2. Why a Chrome extension

A Chrome extension **is** the JS-injection mechanism. The realistic alternatives — userscripts, system MITM proxies, DevTools Protocol — are all worse on at least one axis (friction, certificate trust, distributability, enterprise-readiness).

The single architectural fact worth knowing up front: **MV3's `webRequest` API can no longer access request/response bodies**. So we cannot just listen on `chatgpt.com/backend-api/*`. We monkey-patch `window.fetch` and `window.XMLHttpRequest` from inside the page's main world. That mechanism is identical for all three sites.

Implementation details: [`BROWSER_MVP.md`](BROWSER_MVP.md).

---

## 3. Architecture

```
   Page (chatgpt.com / claude.ai / gemini.google.com)
   • patched window.fetch + XMLHttpRequest (main world)
                  │
                  ▼  postMessage
   Content bridge (isolated world)
                  │
                  ▼  chrome.runtime.sendMessage
   Service worker (background)
   • Stage 1 + 2 redaction
   • IndexedDB buffer
   • HTTPS upload
                  │
                  ▼
            proxai_nest
```

Three components in the extension. The split is forced by the MV3 constraint and by Chrome's isolated/main world separation. Full details and the manifest in [`BROWSER_MVP.md`](BROWSER_MVP.md).

---

## 4. What we capture

All three sites are **verified plaintext-capturable** as of 2026-04-29. Per-site endpoints, body shapes, and parsing notes are in [`CAPTURE_TARGETS.md`](CAPTURE_TARGETS.md).

Summary:

| Site | Capture | Backend parsing |
|---|---|---|
| ChatGPT (`chatgpt.com`) | fetch hook on `/backend-api/conversation`, SSE response | Easy — clean JSON |
| Claude (`claude.ai`) | fetch hook on `/api/.../completion`, SSE response | Easy — clean JSON |
| Gemini (`gemini.google.com`) | fetch hook on `/_/BardChatUi/data/...`, chunked array response | Harder — positional JSON arrays, drifts more — but parsing pain lives on the backend, not in the extension |

The extension's job is the same for all three: capture raw bytes, apply redaction, ship up. Schema fixes for any of them are backend-side and propagate without a client release.

---

## 5. Privacy & redaction

Three-stage redaction, identical model to the desktop gateway:

1. **Stage 1** in the page-injected script before any postMessage — strip `Authorization`, `Cookie`, `X-CSRF-Token`, etc.
2. **Stage 2** in the service worker before IndexedDB write — full `gitleaks` regex pass against the `gitleaks` corpus.
3. **Stage 3** at backend ingest — independent pass with the same shared corpus.

The redaction-rules corpus is published as `@proxai/redaction-rules` and shared between this extension and the desktop gateway so they don't drift.

The browser context is **higher-risk** than the desktop CLI for redaction: users paste secrets into web chat boxes more often than into terminal prompts (bigger text area encourages dumping `.env` files). The corpus should be tuned conservatively for browser context.

---

## 6. MVP scope

### In
- MV3 extension targeting Chrome (and Edge — same manifest)
- Three sites: ChatGPT, Claude, Gemini
- Three components: page-injected, content bridge, service worker
- Stage 1+2 redaction with the shared corpus
- IndexedDB buffer with HTTPS upload to `nest.proxai.co/v1/raw_records`
- First-run page (consent + API key entry)
- Toolbar popup (status, pause, per-site toggle)
- Options page (account, redaction test, diagnostics)
- Chrome Web Store listing

User-visible flows: [`USER_EXPERIENCE.md`](USER_EXPERIENCE.md).

### Out
- Firefox (Phase 2 — manifest tweaks)
- Safari (Phase 4 / never)
- DOM-fallback parsing (kept as escape hatch for Gemini if its wire format ever becomes unworkable)
- Custom site list (Phase 2 — for self-hosted LibreChat / Open WebUI)
- Native messaging integration with desktop gateway (Phase 2)

### Success criteria
- A user installs from the Web Store, pastes their API key, uses the three sites for a day → backend has a complete, redacted record of every turn within 30 seconds of it occurring.
- Zero captured records contain raw `Authorization` headers, `Cookie` values, or matched `gitleaks` patterns. Verified against fuzz corpus.
- Service worker survives 24h+ of intermittent use without losing buffered captures across worker terminations.
- Total bundle size < 1 MB, IndexedDB usage < 10 MB at steady state for a heavy user.

---

## 7. Roadmap

### Phase 0 — verification (already done for all three sites)
- ChatGPT, Claude — known patterns from existing extensions on the store.
- Gemini — verified plaintext via DevTools Network tab (2026-04-29).

### Phase 1 — MVP
- Test extension to verify fetch hooks work end-to-end on real sessions.
- Per-site capture parsers (extension-side: just shape detection, not full parsing).
- Shared `@proxai/redaction-rules` package.
- Service worker + IndexedDB buffer + uploader.
- First-run page, popup, options page.
- Chrome Web Store submission.

### Phase 2 — coverage
- Edge Add-ons listing.
- Firefox port.
- Native-messaging integration with desktop gateway (shared trust, unified status).
- Custom-site support for self-hosted LLM frontends.

### Phase 3 — enterprise
- Chrome Enterprise managed deployment.
- Self-hosted backend mode (mirrors desktop Phase 3).

---

## 8. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Gemini's wire format becomes unworkable | Low (verified plaintext today) | Medium | DOM-fallback parser as escape hatch; backend parser absorbs schema drift centrally |
| Site changes break our fetch hooks | Medium over time | Low (raw shipping → backend fix) | Versioned per-site parsers backend-side |
| User installs on personal device, captures private chats | Medium | Catastrophic for trust | Consent-first first-run; per-site toggle; one-click pause; uninstall is one click |
| Redaction misses a secret typed into chat | Medium | Catastrophic | Three-stage redaction with browser-context-tuned corpus |
| Service worker terminated mid-upload | Medium | Low | IndexedDB persistence + chrome.alarms wake-up |
| Chrome Web Store rejects extension | Low | High | Comply with Web Store policies (purpose-narrow permissions, host-restricted, clear privacy policy) |
| MV3 changes again | Medium over years | Medium | Stay on documented APIs; avoid clever tricks |

---

## 9. Cross-references with the desktop gateway

| | Desktop gateway | Web plugin |
|---|---|---|
| Backend ingest endpoint | `nest.proxai.co/v1/raw_records` | Same |
| API key model | Any account API key | Same |
| Identity field | `machine_id` (per install) | `install_id` (per browser profile) |
| Redaction corpus | `@proxai/redaction-rules` | Same |
| Capture cadence | Polling, every 5 min | Live, on every fetch |
| Update channel | npm (manual) | Chrome Web Store (auto, hours) |
| Update risk window | Up to 90 days (stale-binary auto-pause) | Hours |

The redaction corpus and the upload envelope shape are the two things to factor out as shared packages so the products don't drift.

---

## 10. Open questions

1. **Identity unification.** Should `install_id` (web plugin) and `machine_id` (desktop gateway) be unified into one `client_id` on the same machine? Decide before either product ships, while it's still a field name in an envelope rather than a backend migration.
2. **Native messaging integration.** Phase 2 — should the extension talk to the desktop gateway daemon for shared trust / unified status? Defer.
3. **Per-conversation labels.** Some users will want to mark certain chats as private. Per-site toggle covers the common case; per-conversation may be Phase 3.

---

## 11. Recommended next steps

1. Build the test extension described in `BROWSER_MVP.md` §8 — confirms fetch hooks see the same bytes that DevTools sees, on all three sites.
2. Lock the shared `@proxai/redaction-rules` package between this and the desktop gateway.
3. Confirm with `proxai_nest` that the existing `/v1/raw_records` accepts the web envelope shape (`install_id`, `site`, `endpoint`, `request_body_raw`, `response_body_raw`) or normalize on a single shared envelope schema across both clients.
