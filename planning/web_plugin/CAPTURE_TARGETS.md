# Capture Targets — Web Plugin MVP

The exact endpoints we hook on each target site. One page, no alternatives.

Three sites, one mechanism: monkey-patched `window.fetch` and `window.XMLHttpRequest` running in the page's main world. We see request URL, request body, response body (assembled across SSE chunks), and headers. Streaming responses are teed — the page sees the original stream unchanged; we see a copy.

All three are **verified capturable at the byte level** as of 2026-04-29. The DevTools Network tab can read the request and response bodies as plaintext on each — same JS layer our extension hooks operate on.

---

## ChatGPT — `chatgpt.com`

### Hook

`POST https://chatgpt.com/backend-api/conversation` (and a few sibling endpoints under `/backend-api/`).

### What's in the request

JSON body. Notable fields:
- `messages[]` — the conversation history including the user's new message
- `model` — model selection (e.g., `gpt-5`)
- `conversation_id` — UUID, stable across turns
- `parent_message_id` — links turns into a tree

### What's in the response

`text/event-stream` SSE. Each event is a JSON delta of the assistant message. Final assistant text is reassembled by concatenating the deltas. Tool calls (image gen, code interpreter, web search) come through as separate event types.

### Status

Verified pattern; well-understood from existing public extensions on the Chrome Web Store.

---

## Claude — `claude.ai`

### Hook

`POST https://claude.ai/api/organizations/<org-id>/chat_conversations/<conversation-id>/completion` (verify exact path during the spike — the org/conversation segments are stable, the trailing path may shift).

### What's in the request

JSON body. Notable fields:
- `prompt` — the user's new message
- `model` — model selection
- `parent_message_uuid` — turn linkage
- `attachments` — file uploads as base64 references

### What's in the response

SSE stream of message blocks (text, tool use, tool result). Same reassembly pattern as ChatGPT — concatenate text blocks for the final completion.

### Status

Verified pattern; clean schema, the easiest of the three to parse.

---

## Gemini — `gemini.google.com`

### Hook

`POST https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate` (and other RPC endpoints in the `BatchExecute` family — verify the exact name during the spike since Google's internal RPC names change between deployments).

### What's in the request

`application/x-www-form-urlencoded` body with two fields:
- `f.req` — JSON string containing nested JSON arrays (Google's GWT-style RPC encoding). The user's prompt is in there, deeply nested but plaintext-readable.
- `at` — anti-forgery token, not useful to us.

### What's in the response

Chunked stream of JSON arrays. Each chunk has the shape `[["wrb.fr", ...], ...]` with the assistant's text deeply nested inside positional fields. **Response IS plaintext** — verified empirically via DevTools Network tab on a real session.

### Status

**Verified plaintext capturable.** Parsing is harder than ChatGPT/Claude because:
- Field positions are positional (array indices), not named.
- The internal RPC method names change across Google's deployments.
- Schema drifts more often than the other two.

That parsing cost lives on the backend — our extension ships the raw form-encoded body up; the backend parser handles the array dance and absorbs Google's redeploys without a client release.

### Fallback if the wire format ever becomes unworkable

DOM observation. The rendered chat UI is human-readable HTML. We watch the message containers via `MutationObserver` and capture the rendered text directly. We lose token counts and exact tool-call detail, but reliably get prompt + response. Not on the MVP critical path; documented as the escape hatch.

---

## What we never capture

- Anything outside the three host permissions in `manifest.json`. The extension is scoped at install time and the user sees the scope in Chrome's permission dialog.
- `document.cookie`, `localStorage`, `sessionStorage` — even though our injected script could read them, we explicitly don't.
- Other tabs, other windows, other browsers.
- Browser autofill, password manager extensions.
- Anything while paused (sentinel flag in `chrome.storage.local`).

---

## Schema-drift handling

Same principle as the desktop gateway: capture the raw bytes, ship them up, parse server-side.

For each captured record, the upload envelope includes:
- `site` (`chatgpt` / `claude` / `gemini`)
- `endpoint` (the exact URL that was hooked)
- `request_body_raw` (after Stage 1 redaction)
- `response_body_raw` (after Stage 1 redaction)
- `captured_at` (request start, response end)
- `client.extension_version`, `client.user_agent`

When ChatGPT renames `parent_message_id` → `parent_id`, or Gemini shifts the array position of the assistant text, only the backend parser changes. Extensions on the fleet keep capturing the new bytes correctly without an update.
