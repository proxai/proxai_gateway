# Backend Integration Contract

**Audience:** anyone working on the gateway who needs to know what the backend (`proxai_nest`) expects and why.

This is the **contract** the backend enforces. The gateway-side algorithms (`03_FLUSHING_ALGORITHM.md`, `ALGORITHM_*.md`) describe how the gateway *produces* uploads; this doc describes how the backend *receives* and *validates* them, plus the invariants that — if violated — silently lose data.

If you're changing gateway behavior that touches the wire format, idempotency, redaction, or the watermark, **read this first.** Most of the constraints below exist because of a real bug we've already paid for somewhere.

> **Implementation status (as of doc v2.2):** all three gateway-relevant endpoints are live in `proxai_nest`: `GET /ingestion/verify-key`, `POST /v1/raw_records`, and `GET /v1/watermarks`. The pipeline is pre-production (no real customer traffic), so contract drift can still be corrected cheaply — but the wire shapes below are the ground truth from the shipped server.

---

## 1. The three endpoints, in one paragraph

The backend exposes three HTTP endpoints relevant to the gateway:

1. **`GET /ingestion/verify-key`** — authenticated. The gateway hits this during `install` to validate that the user's ingestion key is real, active, and of type `INGESTION` before writing config. Returns `{ success: true, data: <ApiKey-without-id>, message }` on 200, or `403 Forbidden` if the key is missing/invalid/revoked/wrong-type.
2. **`POST /v1/raw_records`** — accepts a JSON envelope, decompresses the body, runs a defense-in-depth redaction pass, stores the bytes in S3, indexes the row in Postgres, enqueues a parse job, returns. Authenticated via the same **ingestion key** in the `X-API-Key` header. Treated as **at-least-once with capture-id idempotency** — same `capture_id` retried any number of times yields exactly one stored row.
3. **`GET /v1/watermarks?host_id=<sha256>`** — authenticated. Returns the backend's current per-`(source_path_hash, watermark_kind, watermark_table)` watermark cursors for the given `host_id`. Used by the gateway at startup and as a self-healing recovery path after a `400 watermark_regression` from `POST /v1/raw_records`. See §2.4.

The system-level `GET /health` (DB+Redis probe) exists on `proxai_nest` but is **infrastructure-only** — it's hit by Docker HEALTHCHECK / Better Stack Uptime / internal dashboards, never by the gateway. The customer-facing "is my install going to work" probe is `verify-key`.

Everything beyond this paragraph is detail.

---

## 2. The endpoints

### 2.1 Key verification (install-time)

```
GET /ingestion/verify-key
X-API-Key: <ingestion-key>
```

Authenticated by the **ingestion key** in the `X-API-Key` header. The header value is the full key string, format `<random>-<datestr>-<random>` (three hyphen-separated parts). The backend looks up the key by signature hash, validates it's `state: ACTIVE` and `type: INGESTION`, and on success returns the key metadata.

**Successful response (200):**

```json
{
  "success": true,
  "data": {
    "keyName": "my-laptop",
    "userId": "u_abc",
    "key": "<key>",
    "permission": "...",
    "state": "ACTIVE",
    "createdAt": "2026-04-15T...",
    "lastUsed": "2026-05-05T...",
    "type": "INGESTION"
  },
  "message": "Key verified successfully"
}
```

**Failure (403):** key is missing, malformed, revoked (`state: INACTIVE`), or wrong type (e.g. user pasted a SERVICE-type key by mistake). No body content the gateway needs to parse.

The gateway calls this exclusively during `proxai-gateway install`: if 200 with `success: true`, install proceeds and writes config. On 403, install aborts with an "ingestion key rejected" error. On 5xx/network errors, install aborts with a transient-error message and the user can retry.

This endpoint is the customer-facing answer to "is my key going to work?" — it does NOT probe DB/Redis health (that's the operator's `GET /health`, which the gateway never calls).

### 2.2 Raw record upload (not yet live)

```
POST /v1/raw_records
Content-Type: application/json
X-API-Key: <ingestion-key>
```

Authenticated via the user's INGESTION-type API key in the `X-API-Key` header. The header value is the full key string, format `<random>-<datestr>-<random>` (three hyphen-separated parts). The backend looks up the key by signature hash, validates it's `state: ACTIVE` and `type: INGESTION`, and binds the request to the key's owner.

**Important:** the ingestion key is per-user, not per-host. A user may run the gateway on multiple machines, all with the same key, but the backend DOES enforce a per-key host-id allowlist when one is configured.

**Host-id binding (security boundary).** Each INGESTION key carries a `metadata.allowedHostIds` array provisioned at install time. The receive endpoint validates `dto.host_id ∈ apiKeyData.metadata.allowedHostIds` and returns `403 host_id not authorized` on miss. This protects against a stolen ingestion key being used to ingest fake data under another machine's identity.

The `host_id` itself is the lowercase-hex sha256 of `machine_uuid + ':' + user_id` (gateway-side derivation in `core/system/host-id.ts`). The receive DTO requires this exact shape — the regex is `^[a-f0-9]{64}$`. Sending a non-hex `host_id` fails DTO validation with `400` before reaching the allowlist check.

**Multi-machine workflow:** a user binding a second machine to the same INGESTION key must add the new `host_id` to `metadata.allowedHostIds`. The dashboard endpoint that mutates this list is out of scope for the gateway — the user opens it in the web UI and adds the new machine.

**Legacy backfill window:** if `metadata.allowedHostIds` is null/empty AND the env override `AGENT_GATEWAY_ALLOW_LEGACY_HOST_IDS=true` is set, the backend accepts the request and emits the `agent_gateway_host_id_unverified_total` metric for operator visibility. Default is fail-closed.

If the key is missing, malformed, or revoked, the backend returns `403`. If it's accepted but the request fails downstream validation, see §3.2.

### 2.3 Kill switch

The backend has an env-var kill switch. When the upload feature is disabled server-side, every `POST /v1/raw_records` request returns `503 Service Unavailable` with no further processing. The gateway should treat this exactly like a transient outage: retry with backoff, do not advance the watermark, do not pause the local buffer until the documented buffer-full threshold.

This switch exists for fast rollback during incidents. It is set by the operator, not by the gateway. The `/ingestion/verify-key` endpoint is unaffected — the kill switch only gates uploads.

### 2.4 Watermark fetch (pre-flight cursor sync)

```
GET /v1/watermarks?host_id=<64-char-lowercase-hex-sha256>
X-API-Key: <ingestion-key>
```

Returns every per-file cursor the backend currently holds for this user × host:

```json
{
  "host_id": "8a3aed6b9c1f...",
  "user_id": "u_abc",
  "watermarks": [
    {
      "source_app": "claude-code",
      "source_path_hash": "<sha256>",
      "watermark_kind": "byte_range",
      "watermark_table": null,
      "watermark_end": 12345,
      "last_delivered_at": "2026-04-29T10:42:00.000Z"
    },
    {
      "source_app": "codex",
      "source_path_hash": "<sha256>",
      "watermark_kind": "rowid_range",
      "watermark_table": "thread_dynamic_tools",
      "watermark_end": 5000,
      "last_delivered_at": "2026-04-29T10:44:00.000Z"
    }
  ]
}
```

**Use cases:**

1. **Startup sync.** First call after install / reboot: hydrate the local cursor map so the gateway doesn't ship a batch the backend already has.
2. **Recovery from `400 watermark_regression`.** The 400 body (§3.4) carries the offending file's `current_server_watermark_end` directly, but a full re-sync via this endpoint is the canonical "I'm out of sync, snap me back" recovery path.

**Notes:**
- `host_id` is required and must be 64-char lowercase hex (regex `^[a-f0-9]{64}$`). Other shapes return `400`.
- The endpoint is scoped to the API key's owner; it does NOT enforce `metadata.allowedHostIds` because returning an empty list for "host_id not yours" is indistinguishable from "no captures yet" — and the security boundary that matters is on the write side (`POST /v1/raw_records`).
- `watermark_end` is a JSON number. Per §6.5, gateway and backend agree to keep this `< 2^53`; values stored as `bigint` server-side are projected to `Number` at response time.
- Empty `watermarks: []` for a host with no captures is the success case, not an error. Treat it as "server has no cursor; start from 0".
- 200 response bodies are wrapped in the standard `{success, data, message}` envelope at the HTTP boundary; the shape above is `data`.

---

## 3. The wire DTO

```jsonc
{
  "capture_id":          "01943f5a-7b1c-7e92-9c01-a0f3b40d77e3",
  "host_id":             "h_8a3aed6b9c1f...",
  "source_app":          "claude-code",
  "source_kind":         "jsonl_append",
  "source_path":         "/Users/.../session-uuid.jsonl",
  "source_path_hash":    "<sha256(source_path)>",
  "source_inode":        12345678,
  "watermark": { "kind": "byte_range", "start": 1024, "end": 5120, "table": null },
  "agent_schema_version": "2.1.122",
  "gateway_version":     "@proxai/gateway 0.1.4",
  "captured_at_utc":     "2026-04-29T10:42:00.123Z",
  "body_format":         "jsonl",
  "body_compression":    "zstd",
  "body":                "<base64-encoded zstd-compressed bytes>"
}
```

### 3.1 Field reference

| Field | Type | Required | Validation | Notes |
|---|---|---|---|---|
| `capture_id` | string (UUIDv7) | yes | RFC 4122 v7 | Primary idempotency key. See §5. |
| `host_id` | string | yes | 64-char lowercase hex (`^[a-f0-9]{64}$`) | Lowercase-hex sha256 of `machine_uuid + ':' + user_id`. **Pinned to the ingestion key** via `metadata.allowedHostIds` (§2.2). |
| `source_app` | enum | yes | `claude-code` \| `cursor` \| `codex` | Closed; new agents = new value, requires backend release. |
| `source_kind` | enum | yes | `jsonl_append` \| `sqlite_kv_snapshot` \| `sqlite_table_snapshot` | Discriminator; see §4. |
| `source_path` | string | yes | non-empty, `MaxLength(4096)` | Absolute path on host. POSIX PATH_MAX is the cap. |
| `source_path_hash` | string | yes | 64-char lowercase hex (`^[a-f0-9]{64}$`); must equal `sha256(source_path)` | Indexable form. |
| `source_inode` | int (nullable) | yes (may be null) | non-negative | `null` for `sqlite_*_snapshot` (vacuum-into produces a fresh file each poll, inode is meaningless). |
| `watermark.kind` | enum | yes | `byte_range` \| `rowid_range` | Must align with `source_kind`. See §4. |
| `watermark.start` | int | yes | `>= 0` | INCLUSIVE. |
| `watermark.end` | int | yes | `>= 0`, AND `> watermark.start` (DB CHECK) | EXCLUSIVE for `byte_range`; INCLUSIVE for `rowid_range`. **Read §6 carefully.** |
| `watermark.table` | string (nullable) | yes (may be null) | when `source_kind = sqlite_table_snapshot`: required, non-empty | `null` otherwise. |
| `agent_schema_version` | string | yes | `MaxLength(128)`, `^[\w.+:\-]+$` | Free-form upstream marker. See §3.3. |
| `gateway_version` | string | yes | non-empty, `MaxLength(128)` | e.g. `@proxai/gateway 0.1.4`. Used for parser dispatch and drift triage. |
| `captured_at_utc` | string (ISO-8601) | yes | RFC 3339, UTC | Gateway clock when bytes were read off disk. NOT the agent's record timestamp. |
| `body_format` | enum | yes | `jsonl` \| `kv_pairs_json` \| `sqlite_rows_json` | Must align with `source_kind`. See §4. |
| `body_compression` | enum | yes | `zstd` (only value today) | Reserved for future; must be `zstd`. |
| `body` | string (base64) | yes | base64 of zstd-compressed bytes | Size limits: see §7. |

### 3.2 What happens when validation fails

Any DTO field failing validation produces `400 Bad Request` with a generic error message. The backend deliberately does NOT echo specific values back; it logs the detail server-side and returns a generic message. This prevents the endpoint from being used as an oracle to probe other tenants' state.

**Gateway action on 400:** mark the batch as `failed`, surface in `proxai-gateway status`, **do not retry, do not advance watermark.** A 400 means a real bug or schema drift on the gateway side; retrying produces the same result.

**Exception — watermark_regression 400 carries a structured body** so the gateway can self-heal without a follow-up `/v1/watermarks` round-trip. See §3.4.

### 3.3 `agent_schema_version` is per-agent and free-form

| Agent | Source of value | Example |
|---|---|---|
| Claude Code | Top-level `version` field on user/assistant/system/attachment lines (NOT `message.version` — that path is empty in real files); falls back to `"unknown"` | `2.1.122` |
| Cursor | `composerData._v + ':' + bubbleId._v` from the first row of each prefix | `13:3` |
| Codex | `threads.cli_version`, sampled once per state-collection cycle and threaded into the rollout pass | `0.126.0-alpha.8` |

The backend stores it verbatim and uses it for parser dispatch. The receive DTO bounds the value: `MaxLength(128)` and `^[\w.+:\-]+$` (alphanumeric plus `._+:-`). Anything outside that returns `400`.

### 3.4 The structured 400 body — `watermark_regression`

When the receive endpoint detects `watermark.start < highest known watermark_end` for the given `(user_id, host_id, source_path_hash, watermark_table)`, the response is a `400` with this body shape EXACTLY at the top level (no `{success, error}` wrapper):

```json
{
  "error": "watermark_regression",
  "host_id": "8a3aed6b9c1f...",
  "source_path_hash": "<sha256>",
  "current_server_watermark_end": 12345,
  "submitted_watermark_start": 11000,
  "submitted_watermark_end": 11500,
  "watermark_kind": "byte_range",
  "watermark_table": null,
  "message": "Submitted watermark range [11000, 11500) is behind server's known end 12345 for source_path_hash=...; gateway should sync from current_server_watermark_end."
}
```

**Discriminator:** the top-level `error: "watermark_regression"` field. Gateway parsers should match on this string before reading the recovery fields.

**Recovery path:**
1. Update local cursor for `(host_id, source_path_hash, watermark_kind, watermark_table)` to `current_server_watermark_end`.
2. Re-derive the next batch starting at that cursor.
3. Submit with a NEW `capture_id` (the old batch's capture_id is now stale — do not retry the failed batch).
4. Optional safety: call `GET /v1/watermarks?host_id=...` to verify the full cursor map agrees with the local state.

**Why structured-not-generic:** every other 400 path returns the standard `{success: false, error: {code, message}}` wrapper. The watermark-regression path bypasses that wrapper because it's the one error the gateway can recover from automatically — and the recovery requires reading `current_server_watermark_end`, not just a string match. Other 400 paths require human attention (a code change), so they don't need machine-readable bodies.

---

## 4. The three variants

`source_kind`, `body_format`, and `watermark.kind` are tightly coupled. The backend has CHECK constraints that reject combinations outside this matrix:

| `source_app` | `source_kind` | `body_format` | `watermark.kind` | `watermark.table` |
|---|---|---|---|---|
| `claude-code` (always) | `jsonl_append` | `jsonl` | `byte_range` | `null` |
| `codex` (rollout files) | `jsonl_append` | `jsonl` | `byte_range` | `null` |
| `cursor` | `sqlite_kv_snapshot` | `kv_pairs_json` | `rowid_range` | `null` |
| `codex` (state.sqlite tables) | `sqlite_table_snapshot` | `sqlite_rows_json` | `rowid_range` | required (`threads` \| `thread_dynamic_tools` \| `thread_spawn_edges`) |

### 4.1 `jsonl_append` — Claude Code, Codex rollout

The body is verbatim post-redaction bytes from the source file's `[start, end)` range. The backend will split on `\n` per line. **You MUST hold back trailing partial lines** (anything after the last `\n` in your read window). JSONL writers can flush mid-line during high write rates; sending a partial line corrupts the parse.

The backend tolerates per-line parse errors (one bad line is logged and skipped, doesn't fail the batch), but only for genuinely-corrupt lines from the source. Sending an incomplete line will produce a logged parse failure on every retry until the next batch covers the full line.

### 4.2 `sqlite_kv_snapshot` — Cursor

The body is a JSON array of `{ rowid, key, value }` objects pulled from `cursorDiskKV`. Filter on the gateway side: only `composerData:%` and `bubbleId:%` keys ship. Other keys (`agentKv:blob:*`, `checkpointId:*`, `codeBlockPartialInlineDiffFates:*`, etc.) are storage waste and the backend doesn't parse them.

```json
[
  { "rowid": 12001, "key": "composerData:abc-uuid", "value": "<json string>" },
  { "rowid": 12002, "key": "bubbleId:xyz",          "value": "<json string>" }
]
```

`value` is itself a JSON string per Cursor's encoding. The backend handles the inner-JSON parse; ship as-is.

### 4.3 `sqlite_table_snapshot` — Codex

The body is a JSON array of full rows from one specific table. `watermark.table` MUST identify the table. Three tables are in scope:

- `threads` — thread metadata (cwd, git_*, model, sandbox_policy, approval_mode, reasoning_effort, tokens_used, title, cli_version)
- `thread_dynamic_tools` — per-thread dynamic tool inventory
- `thread_spawn_edges` — parent → child thread relationships for sub-agent spawns

```json
[
  { "rowid": 5, "id": "thr-abc", "cwd": "/...", "model": "gpt-5", ... },
  { "rowid": 6, "id": "thr-def", ... }
]
```

Column names come from the SQLite schema. Schema drift (a new column appearing) is OK — `additionalProperties` is permissive in the parsers; new keys ride through and old parsers ignore them.

**All other tables in `state_*.sqlite` are skip-listed.** If you ship a row from a table not in the list above, the backend rejects with `400`.

---

## 5. Idempotency

**`capture_id` is the idempotency key.** Same `capture_id` retried any number of times yields exactly one stored row. The backend uses `INSERT ... ON CONFLICT DO NOTHING`–style semantics on `capture_id`; a duplicate submit returns `200 OK` with `{ accepted: true, idempotent: true }`.

### 5.1 What this means for the gateway

- **Generate `capture_id` ONCE per logical batch.** Persist it in your local upload state; reuse on every retry of the same batch.
- **Never reuse a `capture_id` for a different batch.** If the body changes (e.g. you re-redact and recompose), generate a new `capture_id`.
- **UUIDv7 is required**, not v4. The backend validates the version digit. v7 timestamps make ordering by id deterministic, useful for retroactive diagnostics.

### 5.2 What happens on duplicate

```
First request:  capture_id=X, body=B1 → 200 OK { accepted: true, idempotent: false }
Retry of same:  capture_id=X, body=B1 → 200 OK { accepted: true, idempotent: true }
```

The backend does NOT verify that the body matches the original — it trusts that you sent the same batch. If you submit `capture_id=X` with body `B1`, then later submit `capture_id=X` with body `B2`, the backend treats it as idempotent and ignores `B2`. This is fine in practice because the gateway produces deterministic batches given the same source state.

If you have a legitimate reason to overwrite (e.g. you re-redacted with a newer rule corpus), generate a new `capture_id`.

---

## 6. The watermark — read this section twice

The watermark is the backend's mechanism for detecting "have we processed this byte/row yet." Several constraints below look pedantic; they are not. Each one comes from a real correctness bug.

### 6.1 End semantics — the asymmetry

| `kind` | `start` | `end` | Interpretation |
|---|---|---|---|
| `byte_range` | INCLUSIVE | **EXCLUSIVE** | `[start, end)` — covers bytes from `start` to `end - 1`; total count = `end - start` |
| `rowid_range` | INCLUSIVE | **INCLUSIVE** | `[start, end]` — covers rowids `start` through `end`; total count = `end - start + 1` |

This asymmetry is intentional. Byte ranges naturally use half-open intervals (matches POSIX `read`/`lseek`). SQLite rowids are discrete tokens — `rowid=42` IS a row, not a boundary — so half-open would force you to compute `end+1` everywhere.

The backend stores `watermark_end` with a SQL `COMMENT` documenting the EXCLUSIVE-for-byte-range semantics, and the parser respects it. **If you treat byte-range `end` as inclusive, the backend will silently reject the last byte of every batch as already-processed and you'll lose data.**

### 6.2 The CHECK: `watermark_start < watermark_end`

The backend enforces this at the database level (CHECK constraint). It applies to BOTH variants:

- For `byte_range`: a zero-length capture (`start == end`) carries no bytes. The backend rejects with `400`.
- For `rowid_range`: `start == end` would mean a single row, which seems valid, BUT we standardize on `start < end` everywhere because the per-batch row count is computed differently per variant and we want a uniform invariant. **For a single-row rowid_range, ship `start = N, end = N + 1` semantically — even though it's INCLUSIVE, the convention is the next-row boundary.** In practice the gateway always batches at least 2 rows per snapshot, so this rarely matters.

If `start > end`, the backend rejects with `400`. This is a defensive check: a buggy gateway sending inverted ranges would otherwise corrupt the parser.

### 6.3 Monotonicity per `(host_id, source_path_hash)` — the hard invariant

**For any given `(host_id, source_path_hash)`, captures MUST be uploaded in non-decreasing `watermark.start` order, with no overlap.**

That is: if you ship `[100, 200)` for file F, the next batch for F must satisfy `watermark.start >= 200`.

The backend's stateful parser maintains a per-file watermark cursor keyed by `(user_id, host_id, source_path_hash)` — `user_id` comes from the ingestion key, `host_id` from the DTO. The "have we processed this capture" gate is `MIN(last_processed_watermark) >= c.watermark_end`. If you ship overlapping or out-of-order ranges, the backend's monotonicity guard rejects with `400` and increments a `watermark_regression_total` metric. **It does NOT silently lose data** — that was the v2.7 fix — but it DOES require the gateway to recover.

#### What to do when the source isn't naturally monotonic

For sources that are append-only (Claude Code JSONL, Codex rollout JSONL, Cursor `cursorDiskKV` rowids), monotonicity holds for free.

For sources that aren't (e.g. a snapshot system that resets offsets, or any future case where you'd like to re-key): **change the `source_path` so the `source_path_hash` is different.** The simplest pattern is to append a generation suffix:

```
source_path: "/Users/.../state.vscdb#gen=2"
```

The new `source_path_hash` is a different file from the backend's perspective; watermarks restart from zero with no interference with the old stream.

Do NOT try to reset the watermark on an existing `source_path_hash` — there's no contract for that and it would force the backend to add a special-case "watermark reset" code path we deliberately don't have.

### 6.4 Gateway-side check that backend invariants hold

The backend enforces monotonicity, but the simpler the gateway's behavior, the fewer 400s you have to explain. Recommended gateway-side invariants:

1. Persist `last_max_watermark_end` per `(source_app, source_path, inode)` in your local upload state, BEFORE shipping a batch.
2. When generating a new batch, derive `watermark.start` from the persisted value.
3. After a `200 OK`, advance the persisted value.
4. After a `4xx`, do NOT advance.
5. After a `5xx`, retry with the same `capture_id`; persisted value stays.

For inode rotation (file rolled over, new inode for same path), reset `watermark.start` to 0; this is a fresh stream from the backend's perspective only if `source_inode` changes (the backend does NOT inspect inodes for the file-identity decision — that's `(host_id, source_path_hash)`). If the file path also changes (e.g. log rotation `app.log → app.log.1`), the new path is a different `source_path_hash` and you're fine.

### 6.5 Numeric precision

`watermark.start` and `watermark.end` are JSON numbers. JSON numbers are not safely BigInt-precise above `2^53`. The backend currently accepts numbers and converts to BigInt internally; for realistic file sizes and rowid counts (< 9 quadrillion) this is not a concern.

If you ever need to ship a value above `2^53`, coordinate with the backend team — we'll switch to string-typed numerics on the wire. Until then, the backend asserts `watermark.{start,end} < Number.MAX_SAFE_INTEGER` at receive.

---

## 7. Body size and compression

### 7.1 Hard limits

| Limit | Value | Backend response on overflow |
|---|---|---|
| Compressed body (base64-decoded zstd payload) | 2 MB | `413 Payload Too Large` |
| Decompressed body | 10 MB | `413 Payload Too Large` (after decompress) |
| Decompression timeout | 5 seconds | `408 Request Timeout` |

The decompressed cap exists to defend against zstd bombs (a small compressed payload that explodes to gigabytes). The gateway should keep batches well below these — observed batches are typically `< 50 KB compressed`.

### 7.2 When you'd hit the limit

The 5-min poll cycle naturally bounds batch size to ~5 minutes of activity per file. The only realistic path to overflow is a one-time backfill (gateway was offline for hours, now ships the accumulated diff). For backfills, **chunk into multiple batches** at safe boundaries:

- For `jsonl_append`: split at `\n` boundaries; each batch covers a contiguous byte range.
- For `sqlite_kv_snapshot` / `sqlite_table_snapshot`: split at rowid boundaries; each batch covers a contiguous rowid range.

Each chunk gets its own `capture_id` and its own watermark range. The monotonicity invariant trivially holds because chunks are sequential.

### 7.3 Compression

Use zstd. The backend currently only accepts `body_compression: "zstd"` (CHECK enforced). Compression level is your call; level 3 is fine. Higher levels save little for these payloads and cost gateway CPU.

---

## 8. Response semantics

### 8.1 Status codes

| Code | Meaning | Gateway action |
|---|---|---|
| `200 OK` | Batch accepted (whether new or idempotent retry). | Mark batch `done`. Advance watermark. |
| `400 Bad Request` | DTO validation failed, or watermark monotonicity violated, or table out of scope. Generic error message. | Mark batch `failed`. Surface in `proxai-gateway status`. **Do not retry, do not advance.** |
| `403 Forbidden` | Auth failed: ingestion key missing, malformed, revoked (state INACTIVE), or wrong type (the user accidentally sent a SERVICE-type key). | Treat as **retriable** (key-fix recoverable): keep the batch pending and surface as auth error. Operator must rotate the key. **The gateway should NOT mark the batch failed** — once the key is fixed, the batch retries and succeeds. |
| `408 Request Timeout` | zstd decompression exceeded 5s — likely a malformed body. | Mark batch `failed`. Surface as gateway bug; new `capture_id` won't help. |
| `413 Payload Too Large` | Compressed > 2 MB OR decompressed > 10 MB. | Mark batch `failed`. Re-chunk and re-send with new `capture_id`s. |
| `429 Too Many Requests` | Rate limit hit. | Backoff per the `Retry-After` header (or default 60s). Same `capture_id` retried. |
| `503 Service Unavailable` | Kill switch flipped, OR transient downstream (Postgres/Redis/S3 unhealthy). | Backoff (jittered: 30s → 60s → 2m → 5m → 10m → 30m, cap 1h). Same `capture_id` retried. |
| Other `5xx` | Unexpected server error. | Same as 503: backoff and retry with same `capture_id`. |
| Network error | Connection failed before a response. | Same as 5xx. |

### 8.2 Response body (success path)

```json
{ "capture_id": "01943f5a-7b1c-7e92-9c01-a0f3b40d77e3", "accepted": true, "idempotent": false }
```

`idempotent: true` means the backend already had this `capture_id` and skipped the work. Gateway treats both cases identically (mark done, advance watermark).

### 8.3 Buffer-full behavior

If the backend is unreachable for a sustained period, the local upload buffer fills. Per `01_INTRO.md` §3, a sentinel kill switch (`~/.proxai/PAUSED`) fires when the pending buffer exceeds the configured cap (default 500 MB). After this point the gateway should **stop reading new bytes from sources** until the buffer drains; the watermark stays put. This protects the user's disk from runaway gateway storage.

---

## 9. Rate limits

The backend applies per-API-key throttling matching the existing `INGESTION_LIMITS` shape:

| Window | Limit |
|---|---|
| 1 second | 20 requests |
| 10 seconds | 100 requests |
| 60 seconds | 600 requests |

Realistic gateway traffic (one batch per 5 minutes per source × ~3-5 sources per host) stays well below these. The limits exist to bound damage from a misconfigured or compromised gateway.

When throttled, the backend returns `429` with a `Retry-After` header. Honor it.

---

## 10. Redaction expectations

The system uses **defense in depth**: redaction runs on the gateway side AND again on the backend.

### 10.1 What the gateway does

**Single pass at capture time.** When source bytes are read off disk (Claude Code JSONL, Cursor `cursorDiskKV`, Codex rollout/state), the gateway runs the full redaction rule corpus once, replaces matches with `[REDACTED:type]`, then compresses and stores. The buffered batch is **already-redacted bytes** — the same bytes the wire DTO carries (modulo base64).

There is no second redaction pass at upload time. The buffer is the canonical redacted form; upload just base64-encodes it.

### 10.2 What the backend does

**Receive-time redaction (server-side defense-in-depth).** The backend runs the rule corpus a second time on receive, before the S3 PUT. This catches stale-client drift — an old gateway version that doesn't know about a newer rule yet.

The backend emits a metric (`agent_gateway_redaction_caught_total{rule_name}`) every time the server-side pass finds anything. **A non-zero rate is a signal that the gateway's rule corpus has drifted relative to the backend.** Early-warning system: bump the gateway's bundled rules and ship a release.

### 10.3 What this means for you

- The backend assumes you've redacted before sending. **It will not parse your bytes if they fail the server-side pass with content the backend considers obviously sensitive** — but it will accept them, store them in S3 (post-server-pass), and emit the metric. The metric is the contract.
- Stale gateway redaction is a quality issue, not a security incident: bytes ARE redacted by the time they hit S3. But the slower you fix it, the higher the operational burden on the backend (more server-side catches = more disk churn + alert noise).
- The redaction-rules corpus is intended to be kept in sync. The backend tracks drift via a monthly diff cron; if drift exceeds a threshold, expect coordination outreach.

### 10.4 What you SHOULDN'T redact away

The following must remain unredacted in the body or the parser breaks:

- **JSON structural characters** (`{}[],:"`)
- **Tool / event names** (`Read`, `Bash`, `read_file_v2`, `exec_command`, etc.)
- **Schema field names** (`turn_id`, `chat_id`, `parent_turn_id`, `cwd`, etc.)
- **Watermark-relevant identifiers** (Claude `promptId`, Cursor `bubbleId`, Codex `turn_id`, thread IDs) — these are opaque IDs, not secrets

Redaction rule design should match `value` patterns (API keys, tokens, emails, paths if user requests it) — not field names or structural tokens.

---

## 11. Per-`source_kind` upload checklist

A practical checklist when adding or modifying a source:

### 11.1 `jsonl_append` (Claude Code, Codex rollout)

- [ ] Per-file byte cursor persisted in local SQLite (`source_app, source_path, inode → size_at_last`).
- [ ] On every poll: read `[size_at_last, current_size)`; split at last `\n`; hold back trailing partial line.
- [ ] `watermark.kind = "byte_range"`, `start = size_at_last`, `end = size_at_last + last_complete_byte` (EXCLUSIVE).
- [ ] `body_format = "jsonl"`; body is verbatim post-redaction bytes.
- [ ] On `200 OK`: advance `size_at_last = end`.
- [ ] On inode change: reset `size_at_last = 0`; `source_inode = new_inode`.

### 11.2 `sqlite_kv_snapshot` (Cursor)

- [ ] Use `VACUUM INTO` against `?mode=ro` connection — never copy the live `state.vscdb`.
- [ ] Per-file `last_max_rowid` cursor.
- [ ] On every poll: query `WHERE rowid > last_max_rowid AND (key LIKE 'composerData:%' OR key LIKE 'bubbleId:%') ORDER BY rowid ASC`.
- [ ] `watermark.kind = "rowid_range"`, `start = rows[0].rowid`, `end = rows[-1].rowid` (INCLUSIVE).
- [ ] `body_format = "kv_pairs_json"`; body is `JSON.stringify([{rowid, key, value}, ...])`.
- [ ] `source_inode = null` (snapshot file is fresh per poll).
- [ ] On `200 OK`: advance `last_max_rowid = rows[-1].rowid`.
- [ ] Delete the temp snapshot file after upload.

### 11.3 `sqlite_table_snapshot` (Codex state.sqlite)

- [ ] Use `VACUUM INTO` against `?mode=ro` connection.
- [ ] Per-`(file, table)` `last_max_rowid` cursor — three rows per file (`threads`, `thread_dynamic_tools`, `thread_spawn_edges`).
- [ ] On every poll: for each in-scope table, query `SELECT rowid, * FROM <table> WHERE rowid > last_max_rowid ORDER BY rowid ASC`.
- [ ] `watermark.kind = "rowid_range"`, `start/end` from the row range, `table = "<table_name>"`.
- [ ] `body_format = "sqlite_rows_json"`; body is `JSON.stringify([dict(row) for row in rows])`.
- [ ] `source_inode = null`.
- [ ] **Skip-list enforced at the unit-test level** — never let a new table accidentally ship.

---

## 12. Common pitfalls

These are the bugs we've seen or anticipate. Avoiding them up-front saves real time.

### 12.1 Tearing JSONL lines mid-line

**Symptom:** parser sees corrupted JSON; per-line failure rate spikes.
**Cause:** read window happened to land mid-line during a write.
**Fix:** always split at last `\n`; hold back any trailing bytes for the next poll.

### 12.2 Sending `watermark.end` as inclusive for byte_range

**Symptom:** silent data loss (the last byte of every batch is "already processed" per the backend's filter).
**Fix:** `watermark.end` for `byte_range` is EXCLUSIVE. `[start, end)`.

### 12.3 Reusing `capture_id` across different bodies

**Symptom:** changes you intended to ship don't appear in the backend; appears as if the retry succeeded but didn't.
**Cause:** backend returned `idempotent: true` because it already saw that `capture_id`.
**Fix:** generate a new `capture_id` whenever the body changes (e.g. after a redaction-rule update). Same body across retries: keep the id.

### 12.4 Non-monotonic watermarks via path stability

**Symptom:** `400 watermark_regression_total` errors.
**Cause:** sent a batch with `watermark.start < previous batch's watermark.end` for the same `(host_id, source_path_hash)`.
**Fix:** for genuinely non-monotonic sources, change `source_path` (e.g. add `#gen=2` suffix) so the `source_path_hash` differs.

### 12.5 Forgetting to gate the Cursor key filter

**Symptom:** body is 10× expected size; redaction CPU dominates poll cycle; eventually hit 413.
**Cause:** `cursorDiskKV` has many key types; `agentKv:blob:*` alone is several hundred rows of provider-format cache.
**Fix:** the gateway WHERE clause must restrict to `key LIKE 'composerData:%' OR key LIKE 'bubbleId:%'`. Other keys are storage waste.

### 12.6 Shipping a Codex table not in scope

**Symptom:** `400 source_kind_check`-related rejection.
**Cause:** ship-listed a Codex `state.sqlite` table outside `threads | thread_dynamic_tools | thread_spawn_edges`.
**Fix:** the in-scope set is enforced both client-side (skip-list) and server-side (CHECK constraint). Add new tables only after backend coordination — they require parser support.

### 12.7 Sending the wrong key type or a revoked key

**Symptom:** every upload returns `403`; user reports "I just installed".
**Cause:** the user supplied a SERVICE-type API key instead of an INGESTION key, or the key was revoked after install.
**Fix:** the user creates a fresh INGESTION key in the dashboard and re-runs `proxai-gateway install`. Existing pending batches retry automatically once the new key is in place — the gateway treats 403 as retriable for exactly this reason.

### 12.8 Numeric precision overflow

**Symptom:** Possible at huge file sizes (`> 2^53` bytes ≈ 9 PB) or rowid counts. Not realistic today.
**Fix:** if the gateway ever ships numbers above `2^53`, coordinate with backend before deploy. Currently the backend accepts numbers and converts to BigInt internally; values above `MAX_SAFE_INTEGER` would lose precision in JSON parse.

### 12.9 Not handling the kill switch

**Symptom:** during incident response (kill switch flipped), gateway batches go straight to `failed` queue and surface as scary alerts.
**Fix:** treat `503` exactly like a transient outage: backoff and retry with the same `capture_id`. The kill switch is operator-controlled, expected to flip back.

---

## 13. End-to-end trace

To help with debugging, the backend emits structured logs tagged with `capture_id` at every async boundary. If you have a problematic upload, the operator can search the backend logs by `capture_id` and walk the timeline:

```
event:agent-gateway capture_id:"<your-uuid>"
```

This returns: receive accepted → S3 PUT → enqueue → parse start → record write (one line per parsed record). For diagnosis purposes, attach the `capture_id` of any problematic batch to bug reports.

The gateway does NOT need to emit structured logs in the same format — but logging the `capture_id` of every batch you ship makes correlation trivial.

---

## 14. Versioning and extensibility

### 14.1 What's frozen

The DTO envelope (field names, types, enum values for closed enums) is frozen. Adding new fields is non-breaking; renaming or removing fields requires a coordinated version bump.

### 14.2 What's extensible

- **`agent_metadata` keys** (per-agent loose dict): backend parsers may add or remove keys at any time. Drift is tolerated by design.
- **New tool names, new event types in JSONL bodies**: parsed where possible; unknown values pass through.
- **New SQLite columns** in scope tables: parsed via `dict(row)`; new columns ride through automatically.

### 14.3 What requires backend coordination

- New `source_app` value (e.g. adding Antigravity, Devin, etc.).
- New `source_kind` (e.g. a new file format).
- New `body_format`.
- New `body_compression` (e.g. switching to brotli).
- New Codex table in scope.
- Changes to redaction rule corpus naming.

In each case: open a discussion with the backend team, ship the backend change first (CHECK constraint relaxation, parser support), then ship the gateway change.

### 14.4 What requires NO coordination

- Bug fixes in existing parsers' redaction or processing logic.
- New `agent_metadata` keys.
- Compression-level tuning.
- Internal gateway refactors.
- Local-buffer tuning.

---

## 15. Quick reference — what the backend rejects with 400

To save you a round-trip when reviewing a draft change, the most common 400 paths:

- Missing or empty required field
- `capture_id` not UUIDv7 format
- `host_id` or `source_path_hash` not 64-char lowercase hex (`^[a-f0-9]{64}$`)
- `source_path` longer than 4096 chars
- `agent_schema_version` longer than 128 chars or contains characters outside `[\w.+:\-]`
- `gateway_version` longer than 128 chars
- `source_app`, `source_kind`, `body_format`, `body_compression`, `watermark.kind` outside the closed enums
- `(source_kind, body_format, watermark.kind)` triple not in §4 matrix
- `watermark.start >= watermark.end` (DB CHECK)
- `watermark.start` for this `(host_id, source_path_hash, watermark.table)` is less than the highest known `watermark.end` — **structured body, see §3.4**
- For `sqlite_table_snapshot`: `watermark.table` missing or not in `[threads, thread_dynamic_tools, thread_spawn_edges]`
- `body` not valid base64
- `body` exceeds 2 MB compressed or 10 MB decompressed
- `captured_at_utc` not valid ISO-8601 in UTC

### 15.1 What the backend rejects with 403

- API key missing / malformed / revoked / wrong type (treat as retriable per §8.1)
- `dto.host_id` not in `metadata.allowedHostIds` for this API key (operator must add the host_id; treat as retriable for the same reason)

---

## 16. Contacts and escalation

- **Schema questions:** open a discussion in the gateway/backend repos before shipping.
- **Production incidents:** the backend team has on-call coverage; the runbook surfaces `capture_id`-based diagnostics first.
- **Redaction rule drift:** the backend runs a monthly drift check and will reach out if a coordinated update is needed.

When in doubt, send a small diff and ship to dev/preview first. The backend has full observability into what arrived and what the parsers did with it; running a single host through preview for an hour catches most surprises.

---

**Document version:** 2.2
**Last updated:** 2026-05-06
**Backend implementation:** `proxai_nest`, agent-gateway module
**Gateway implementation:** `@proxai/gateway`

**Changelog from v2.1 → v2.2:**
- `POST /v1/raw_records` is now **live** server-side (pre-prod, no real customer traffic).
- **Restored host-id pinning.** v2.0 removed the allowlist; v2.2 reinstates it as a security boundary. The receive endpoint enforces `dto.host_id ∈ apiKeyData.metadata.allowedHostIds` fail-closed when the list is configured. v2.0's "no allowlist" framing was wrong about the shipped server. See §2.2.
- **New endpoint: `GET /v1/watermarks?host_id=<sha256>`.** Returns per-file cursor map for pre-flight sync + recovery. See §2.4.
- **Structured 400 body for `watermark_regression`.** Discriminator at top level (`error: "watermark_regression"`) + recovery fields (`current_server_watermark_end`, etc.). See §3.4.
- **DTO bounds tightened:** `host_id` and `source_path_hash` must be 64-char lowercase hex; `source_path` capped at 4096; `agent_schema_version` capped at 128 chars + `[\w.+:\-]` charset; `gateway_version` capped at 128 chars. See §3.1.
- Monotonicity scope corrected: `(host_id, source_path_hash, watermark.table)`. Earlier docs implied the table dimension was not part of the cursor key — that was wrong for codex multi-table snapshots.

**Changelog from v2.0 → v2.1:**
- Install flow now hits `GET /ingestion/verify-key` (customer-facing key check) instead of `GET /health` (operator-only DB/Redis probe). The gateway never calls `/health`. Customers shouldn't see infra health probes — they care about whether their key works.
- Verify-key endpoint requires `X-API-Key` header and returns `{ success, data, message }` shape. 403 = key invalid/revoked/wrong-type.

**Changelog from v1.0 → v2.0:**
- Auth scheme: `Authorization: Bearer` → `X-API-Key`
- Removed: dedicated `AGENT_GATEWAY` API-key type; replaced by reusing the user's existing **INGESTION-type** keys.
- ~~Removed: host pinning (`metadata.allowedHostIds`).~~ **Reverted in v2.2.**
- Removed: `POST /v1/auth/validate`, `PATCH /v1/api-keys/<key>/allowed-hosts`, `GET /v1/gateway/latest_version` endpoints.
- 403 semantics: now retriable (key-fix recoverable) instead of terminal-failed for the upload path.
- `POST /v1/raw_records` is documented but **not yet live** server-side — gateway tests must mock the upload path.
