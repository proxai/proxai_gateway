# Flushing Algorithm — Gateway-Side Capture & Shipping

> **DEPRECATED** as of 2026-05-06.
> The high-level algorithm — per-source watermark, redact, batch, ship — still
> matches what the code does. Most concrete details have moved on. The
> authoritative wire contract is now `planning/nest-contract.md`. The
> per-source capture algorithms live in `planning/ALGORITHM_CLAUDE.md`,
> `ALGORITHM_CURSOR.md`, and `ALGORITHM_CODEX.md` (see those for the up-to-date
> capture mechanics). The implementation is in `src/sources/{claude-code,cursor,codex}/collect*.ts`
> and `src/services/{buffer,uploader,polling}/`.
>
> Specific items now stale:
> - **Auth scheme:** `X-API-Key`, not `Authorization: Bearer` (§3.1, §3.2). See
>   `nest-contract.md` §2.
> - **Redaction:** single-pass at capture time (13 categories, 100+ rules), not
>   the "two-stage gateway redaction" described in §8. The buffered batch is
>   already redacted; the upload step just base64-encodes the existing bytes.
> - **`capture_id` is UUIDv7, not UUIDv5.** §9.1 proposes a deterministic
>   uuidv5-of-position scheme; the shipped implementation uses UUIDv7 generated
>   per batch. Crash-window duplicates are absorbed by server-side dedup on
>   `(host_id, source_path_hash, watermark_kind, watermark_start, watermark_end,
>   watermark_table)` — see `audit_crash_recovery.md` for the audit.
> - **`host_id`:** deterministic per `nest-contract.md` §5.4
>   (`sha256(machine_uuid + ':' + user_id)`), not "sha256 of machine UUID + install
>   salt". Salt rotation in §11.3 is obsolete.
> - **Buffer-full sentinel:** hysteresis-based `BUFFER_FULL` (default 700 MB
>   pause / 600 MB resume), not `PAUSED` at >500 MB pending (§3.4). `PAUSED` is
>   the user-controlled sentinel.
> - **Vacuum / rowid regression detection:** the `#gen=N` source_path rotation
>   pattern is implemented in `src/services/buffer/vacuum-detect.ts` and
>   `src/sources/cursor/collect.ts`. It supersedes the "PK includes inode" trick
>   in §6.7.
> - **Initial-scan window cap:** the gateway only captures source files modified
>   within the last `initialScanWindowDays` (default 30) on first contact;
>   `proxai-gateway backfill --since <duration>` is the way to ingest older
>   history.
> - **`blob_snapshot` source kind (§5.6, §6.5, §8.3) was never shipped.** Tool
>   results stay inline in the JSONL; `workspace.json` / `session_index.jsonl`
>   are not separate captures. Backend support for `blob_snapshot` is also
>   absent — the contract matrix in `nest-contract.md` §4 has only three
>   variants (jsonl_append, sqlite_kv_snapshot, sqlite_table_snapshot).
> - **§3.4 "200 OK on receive" reaction:** the cursor advances at
>   capture-into-buffer time, not on server accept. The audit at
>   `audit_crash_recovery.md` documents the rationale.
>
> Kept for archaeological value: the §2 architecture diagram, the §3.3
> invariants table (linear-stream reconstruction, idempotency, schema-version
> dispatch), the per-agent algorithm shapes in §5–§7, and the redaction
> placement on the laptop — those are still right in spirit.

---

**Status:** v0.1
**Owner:** ProxAI
**Scope:** What the on-laptop gateway does. How it detects new data per agent, packages it, and sends it to the backend. **No parsing.** The gateway is a raw-bytes shipper.

> **Companion docs:**
> - `01_INTRO.md` — overall architecture and component split (gateway vs. `proxai_nest` backend).
> - `04_AGENT_CALL_RECORD.md` — the typed record the backend produces from raw bytes (irrelevant to gateway code).
> - `05_AGENT_CALL_RECORD_MAPPING.md` — how raw fields map to `AgentCallRecord` (backend concern).
> - `02_CLI_DESIGN.md` — operator commands (install/start/stop/pause/status/tail).

The gateway is small on purpose. It does **four things**: (1) every 5 minutes, (2) detect what's new in each watched source, (3) redact, (4) ship the raw bytes to the backend. The backend is responsible for parsing them into `AgentCallRecord`s. This split is locked in `01_INTRO.md` §2; nothing in this doc weakens it.

---

## 1. What this doc decides

Three things, scoped tightly:

1. **The poll loop.** Per-source watermark, 5-min cadence, redact, batch, ship. §4.
2. **The backend contract.** One endpoint (`POST /v1/raw_records`) with a discriminated DTO carrying everything the backend needs to: order batches, dedup, identify the source agent and its schema version, and reassemble the linear stream. §3.
3. **Per-agent capture details.** Paths, watermark mechanism, edge cases. §5–§7.

What this doc explicitly does **not** cover:
- Parsing raw bytes into `AgentCallRecord`. That's the backend's job.
- Metadata extraction (cwd / git / sandbox / etc.). Backend.
- Token estimation / cost computation. Backend.
- AgentCallRecord schema design. See `04_AGENT_CALL_RECORD.md`.

---

## 2. Architecture in one picture

```
┌─────────────────────────────────────────────────────────┐
│                  USER'S LAPTOP                          │
│                                                         │
│  ~/.claude/projects/**/*.jsonl       (Claude Code)      │
│  ~/.codex/sessions/**/*.jsonl        (Codex rollouts)   │
│  ~/.codex/state_*.sqlite             (Codex sidecar)    │
│  ~/Library/.../Cursor/.../state.vscdb (Cursor)          │
│                          │                              │
│                          ▼                              │
│   ┌───────────────────────────────────────────────┐     │
│   │     proxai-gateway (this repo)                │     │
│   │                                               │     │
│   │   Every 5 min, per source:                    │     │
│   │     1. Detect what's new (watermark)          │     │
│   │     2. Redact (gitleaks + detect-secrets)     │     │
│   │     3. Compress (zstd)                        │     │
│   │     4. Ship to backend (HTTPS POST)           │     │
│   │                                               │     │
│   │   Local SQLite buffer (~/.proxai/gateway.db)  │     │
│   │     • per-source watermark                    │     │
│   │     • pending upload batches                  │     │
│   │     • retry queue                             │     │
│   └─────────────────────────┬─────────────────────┘     │
└─────────────────────────────┼───────────────────────────┘
                              │
                  HTTPS POST /v1/raw_records (DTO §3)
                              │
                              ▼
┌─────────────────────────────────────────────────────────┐
│              proxai_nest (backend, separate repo)       │
│                                                         │
│   /v1/raw_records  →  object storage (raw blobs)        │
│           ↓                                             │
│   Per-agent parser  →  AgentCallRecord                  │
│   (versioned, re-runnable on demand)                    │
└─────────────────────────────────────────────────────────┘
```

**The hard line:** the gateway never parses agent JSON / SQLite values. It transports bytes. Schema drift in agent data is a backend parser concern, not a gateway concern.

---

## 3. Backend contract

### 3.1 One endpoint

```
POST /v1/raw_records
Content-Type: application/json
Authorization: Bearer <gateway-key>      # provisioned at install time
```

**Why one endpoint, not three?** Each `source_kind` (JSONL append, SQLite KV snapshot, SQLite table snapshot) carries its own watermark shape, but the request envelope, auth, retry semantics, and idempotency key are identical. One endpoint keeps the gateway's network code single-path. The backend dispatches internally on `source_kind`.

### 3.2 The DTO

```jsonc
{
  "capture_id":          "01943f5a-7b1c-7e92-9c01-a0f3b40d77e3",
  // UUIDv7, gateway-generated. PRIMARY IDEMPOTENCY KEY.
  // Same batch retried → same id → backend upsert is identity.

  "host_id":             "h_8a3aed6b9c1f...",
  // sha256 of (machine UUID || gateway install salt). Anonymous; no PII.
  // Lets backend group "all records from one laptop" without knowing the user.

  "source_app":          "claude-code",
  // 'claude-code' | 'cursor' | 'codex'. Closed enum; new agents = new value.

  "source_kind":         "jsonl_append",
  // 'jsonl_append' | 'sqlite_kv_snapshot' | 'sqlite_table_snapshot'.
  // Discriminator for the watermark and body_format below.

  "source_path":         "/Users/.../session-uuid.jsonl",
  // Absolute path on the host. Carries username; this is acknowledged in
  // `01_INTRO.md` privacy section. Backend stores it on the raw blob;
  // strips usernames in any user-visible surface.

  "source_path_hash":    "sha256(source_path)",
  // For indexing without exposing path; same value across uploads
  // of the same file.

  "source_inode":        12345678,
  // file inode on the host. Detects rotation: a new inode for the same
  // path = new file (start watermark from 0). null for sqlite_*_snapshot
  // because vacuum-into snapshots produce new files each poll.

  "watermark": {
    "kind":  "byte_range",
    // 'byte_range' for jsonl_append; 'rowid_range' for sqlite_*_snapshot.

    "start": 1024,
    // INCLUSIVE first byte (or first rowid).
    "end":   5120,
    // EXCLUSIVE byte (so [start, end) is the interval); or INCLUSIVE max
    // rowid for rowid_range. Document this clearly per source_kind.

    "table": null
    // 'cursorDiskKV' / 'threads' / 'thread_dynamic_tools' / etc.
    // Required for sqlite_table_snapshot, null otherwise.
  },

  "agent_schema_version": "2.1.122",
  // Best-effort upstream marker:
  //   Claude Code: `message.version` field (sniffed from the JSONL chunk;
  //                if no records this batch, last-seen value).
  //   Cursor:      composerData._v + ':' + bubbleId._v ('13:3').
  //   Codex:       threads.cli_version ('0.126.0-alpha.8').
  // Lets the backend dispatch to the right parser version.

  "gateway_version":     "@proxai/gateway 0.1.4",
  // The release that produced this batch. Used for parser dispatch and
  // schema-drift triage.

  "captured_at_utc":     "2026-04-29T10:42:00.123Z",
  // Gateway clock when the bytes were read off disk. NOT the agent's
  // record timestamp.

  "body_format":         "jsonl",
  // 'jsonl' (newline-delimited bytes verbatim, post-redaction)
  // 'kv_pairs_json' (JSON array of {key, value} from cursorDiskKV)
  // 'sqlite_rows_json' (JSON array of full rows for typed tables).
  "body_compression":    "zstd",
  "body":                "<base64-encoded zstd-compressed bytes>"
}
```

### 3.3 Why this DTO is "enough context"

Concrete invariants the backend can rely on, with proof points:

| Invariant | How the DTO supports it |
|---|---|
| **Linear-stream reconstruction** (JSONL) | Sort batches by `(host_id, source_path_hash, source_inode, watermark.start)`. Concatenate bodies. The post-redaction bytes are byte-identical to what was on disk in the same byte range; the agent's append-only writes never overwrite. |
| **Out-of-order arrival is OK** | Batches can arrive in any order (gateway retries, network jitter). Order in the stream comes from `watermark.start`, not arrival time. |
| **Idempotency** | `capture_id` is the upsert key. Same batch retried → no duplicate. |
| **File rotation detection** | New `source_inode` for the same `source_path` = new file. Backend treats them as separate streams. |
| **Schema-version dispatch** | `agent_schema_version` + `source_app` + `gateway_version` is enough to pick the right parser. |
| **Re-parse on demand** | Backend stores the raw blob keyed by `capture_id`. New parser version → re-run over the blob; upsert by deterministic id (per `04_AGENT_CALL_RECORD.md` §2.10). |
| **Failure isolation** | A single bad batch (corrupt body, parse error) is just one row in the raw store; doesn't block other batches. |

### 3.4 Response & retry

| Response | Gateway action |
|---|---|
| `200 OK` | Mark batch `done`. Advance watermark. |
| `4xx` (auth, malformed) | Mark batch `failed`. Surface in `proxai-gateway status`. **Do not advance watermark** — operator intervention required. |
| `5xx` / network error | Exponential backoff (jittered: 30 s, 60 s, 2 m, 5 m, 10 m, 30 m, cap 1 h). Watermark stays put; same `capture_id` retried. |
| Backend unreachable for hours | Local buffer fills until `~/.proxai/PAUSED` sentinel kill switch fires (>500 MB pending — bound configurable). Gateway logs and waits. |

---

## 4. The poll loop (common to all sources)

```
every 5 min:
    for source in glob(watched_paths):
        wm = load_watermark(source)               # SQLite buffer
        new_data = read_new(source, wm)           # source-specific (§5–7)
        if new_data is empty:
            update last_seen_at; continue
        redacted = redact(new_data)               # see §8
        compressed = zstd(redacted)
        batch = upload_batch.insert({
            capture_id: uuidv7(),
            ...DTO fields per §3.2...
            body: base64(compressed),
            state: 'pending',
        })
        # uploader runs concurrently:
    for batch in upload_batch where state='pending':
        ship(batch)                               # POST /v1/raw_records
        on 2xx: state='done'; advance_watermark(source, batch.watermark.end)
        on 4xx: state='failed'; alert
        on 5xx/network: state='pending'; back off
```

The poll loop is one process per source, run sequentially within the gateway process. Total wall-time per cycle: dominated by network upload (single-file deltas in 5 min are typically <50 KB compressed). For the user's longest active Claude Code session (8.4 MB total over a week), each 5-min slice is ~4 KB. Bandwidth is a non-concern.

---

## 5. Claude Code

### 5.1 Where the data lives

```
~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl       ← READ
~/.claude/projects/<encoded-cwd>/<session-uuid>/             ← READ children:
    tool-results/<short-hash>.txt                            ←   externalized tool outputs
    subagents/agent-<id>.jsonl + agent-<id>.meta.json        ←   sub-agent transcripts

NEVER READ:
~/.claude/settings.json          (user secrets)
~/.claude/sessions/              (internal PID→session map)
~/.claude/cache/, statsig/, telemetry/, plugins/, skills/, todos/, memories/
~/.claude/history.jsonl          (cross-project pasted-secrets risk)
```

`<encoded-cwd>` replaces `/` and `_` with `-` and is **lossy**; we never derive paths from it (path lives inside the records).

### 5.2 Source kind: `jsonl_append`

Each session JSONL is append-only. The gateway keeps a per-file byte cursor.

```sql
-- in ~/.proxai/gateway.db
CREATE TABLE file_cursor (
  source_app    TEXT NOT NULL,
  source_path   TEXT NOT NULL,
  inode         INTEGER NOT NULL,
  size_at_last  INTEGER NOT NULL,         -- bytes confirmed shipped
  last_seen_at  REAL NOT NULL,
  PRIMARY KEY (source_app, source_path, inode)
);
```

### 5.3 The 5-min cycle, per Claude Code JSONL file

```
1. (cur_inode, cur_size, _) = stat(path)
2. row = SELECT FROM file_cursor WHERE source_app='claude-code' AND source_path=path
3. if row is missing OR row.inode != cur_inode:
       offset = 0; inode = cur_inode      # new file or rotation
   else:
       offset = row.size_at_last
       inode  = row.inode
4. if cur_size <  offset: reset offset = 0; log a WARN (file truncated — unexpected)
   if cur_size == offset: update last_seen_at; continue
5. raw = read(path, offset, cur_size - offset)        # one syscall
6. (clean_chunk, last_complete_byte) = split_at_last_newline(raw)
   # if raw doesn't end in \n, hold back the trailing partial line —
   # JSONL writers can flush mid-line during high write rates
7. redacted = redact(clean_chunk)
8. INSERT upload_batch with watermark.byte_range = [offset, offset+last_complete_byte)
9. on 2xx: file_cursor.size_at_last = offset + last_complete_byte
```

### 5.4 What's in the body

Verbatim post-redaction bytes from the source file. `body_format = "jsonl"`. The backend parses into individual records by splitting on `\n`. Per-line failure isolation in the backend handles bad lines.

### 5.5 Sub-agent files

Sub-agent transcripts at `<session-dir>/subagents/agent-*.jsonl` are tracked as **separate** sources by the same algorithm (each has its own row in `file_cursor`). They get their own DTO uploads with `source_path` = the sub-agent file. The backend joins them to the parent record by parsing the parent's `Task` tool_use call_id (per `04_AGENT_CALL_RECORD.md` §2.4). **The gateway does not need to know about sub-agents.** It just tails JSONL files.

### 5.6 Externalized tool results

Files at `<session-dir>/tool-results/<hash>.txt` carry tool outputs that exceeded an inline-size limit. We track them as separate sources too (`source_kind = "jsonl_append"` is wrong; we use `source_kind = "blob_snapshot"` — see §8.3). The backend joins by hash from the parent JSONL's tool_result block.

### 5.7 Edge cases

| Case | Handling |
|---|---|
| **File deleted** | `stat` ENOENT → keep `file_cursor` row; no new uploads. Backend already has whatever shipped. |
| **File rotated** (new inode, same path) | New `file_cursor` row (PK includes inode). Old inode's row stays, becomes inert. |
| **Live writer mid-flush** | `split_at_last_newline` holds back partial trailing line. Picked up next poll. |
| **Process crash mid-poll** | `upload_batch` row may exist in `pending` state without a network attempt. Uploader picks it up on next loop. |
| **Same range shipped twice** | Backend dedups on `capture_id`. |

---

## 6. Cursor

### 6.1 Where the data lives

```
~/Library/Application Support/Cursor/User/globalStorage/state.vscdb     ← READ ONLY
~/Library/Application Support/Cursor/User/workspaceStorage/<hash>/workspace.json   ← READ (small JSON)
~/Library/Application Support/Cursor/User/globalStorage/storage.json    ← READ (small JSON)

NEVER READ:
state.vscdb-shm, state.vscdb-wal     (we read a snapshot, not these)
state.vscdb.backup
ItemTable inside state.vscdb         (auth tokens — explicitly skip-listed)
all non-*.vscdb files under Cursor/
```

**Important correction vs. an earlier doc:** all conversation content lives in the **global** `state.vscdb`. Workspace `state.vscdb` files have no `cursorDiskKV` rows in observed data — only `workspace.json` is worth capturing from workspace storage (for cwd-to-folder mapping).

### 6.2 Source kind: `sqlite_kv_snapshot`

Cursor uses SQLite WAL; a naive `cp` can produce a torn read. Always use `VACUUM INTO`:

```bash
sqlite3 "file:state.vscdb?mode=ro" "VACUUM INTO '/tmp/proxai-cursor-snap-<uuid>.db'"
```

The snapshot is a fresh file — no WAL, no live writes, safe to read. We delete it after the upload.

The watermark is the **monotonic `rowid`** in `cursorDiskKV`. SQLite's `INSERT OR REPLACE` produces a delete-then-insert internally, which assigns a new (higher) rowid. Tracking `max(rowid)` per snapshot catches both new rows and updates.

```sql
CREATE TABLE source_watermark (
  source_app       TEXT NOT NULL,
  source_path      TEXT NOT NULL,
  table_name       TEXT NOT NULL DEFAULT '',
  last_max_rowid   INTEGER NOT NULL,
  last_seen_at     REAL NOT NULL,
  PRIMARY KEY (source_app, source_path, table_name)
);
```

### 6.3 The 5-min cycle for Cursor

```
1. tmp = "/tmp/proxai-cursor-snap-<uuid>.db"
2. sqlite3 "file:<live_path>?mode=ro" "VACUUM INTO '<tmp>'"
3. row = SELECT last_max_rowid FROM source_watermark
        WHERE source_app='cursor' AND source_path=<live_path> AND table_name=''
   offset = row.last_max_rowid OR 0
4. rows = SELECT rowid, key, value
          FROM cursorDiskKV
          WHERE rowid > <offset>
            AND (key LIKE 'composerData:%' OR key LIKE 'bubbleId:%')
          ORDER BY rowid ASC
   # SKIP everything else: agentKv:blob:* (242 rows of provider-format
   # cache; redundant with bubbles, plus would 5-10x storage), checkpointId:*,
   # codeBlockPartialInlineDiffFates:*, etc.
5. if rows is empty: update last_seen_at; continue
6. body = json.dumps([{"rowid": r.rowid, "key": r.key, "value": r.value}
                     for r in rows])
7. redacted = redact(body)
8. INSERT upload_batch with watermark.rowid_range = [rows[0].rowid, rows[-1].rowid]
   body_format = "kv_pairs_json"
9. on 2xx: last_max_rowid = rows[-1].rowid
10. delete tmp file
```

### 6.4 What's in the body

A JSON array of `{rowid, key, value}` objects — the raw key-value pairs from `cursorDiskKV`. Values are themselves JSON strings (per Cursor's encoding); the gateway ships them as-is post-redaction. `body_format = "kv_pairs_json"`.

### 6.5 Workspace mapping (small static reads)

`workspace.json` and `storage.json` carry small static JSON. They change rarely. The gateway reads them once per poll cycle (cheap) and ships if the mtime changed:

```
source_kind: "blob_snapshot"
body_format: "raw_json"
body: full file content
```

The backend uses `workspace.json[].folder` to map workspace hashes → repo paths if it ever needs cross-workspace correlation. Not used by MVP analytics.

### 6.6 Multi-window / concurrency

Cursor is a single Electron process per machine. Only one writer to `state.vscdb`. The gateway and Cursor are concurrent (gateway reads, Cursor writes), and `VACUUM INTO` against a `?mode=ro` connection is safe under that. Multiple Cursor windows share the same backend process — no extra concern.

### 6.7 Edge cases

| Case | Handling |
|---|---|
| **Snapshot fails** (disk full, SQLite locked) | Skip this poll; retry next. |
| **rowid wraps** | SQLite rowid is `INTEGER PRIMARY KEY` (signed 64-bit). Wrap-around in practice = never. |
| **Composer deleted** | Rows just disappear; no new rowids. We've already shipped what was there. |
| **Cursor writes between vacuum-into and read** | The snapshot is point-in-time; subsequent writes are caught next poll. |

---

## 7. Codex

Codex is **two sources, one agent**. The gateway runs both collectors in the same poll cycle:

1. **Rollout JSONL** at `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ISO>-<thread-uuid>.jsonl` — `source_kind = "jsonl_append"`.
2. **Sidecar SQLite** at `~/.codex/state_*.sqlite` — `source_kind = "sqlite_table_snapshot"` for three tables.

The backend joins them by `thread_uuid` (= filename UUID = `session_meta.payload.id` = `state.threads.id`). The gateway doesn't know or care about the join; it just ships both source kinds independently.

### 7.1 Where the data lives

```
~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl    ← READ (jsonl_append)
~/.codex/state_*.sqlite                                ← READ (sqlite_table_snapshot)
                                                         pick highest-numbered when multiple match
                                                         (e.g., state_5.sqlite over state_4.sqlite)
~/.codex/session_index.jsonl                          ← READ (small JSON; thread title index)

NEVER READ:
~/.codex/auth.json               (OpenAI tokens)
~/.codex/installation_id
~/.codex/logs_2.sqlite           (application logs, not LLM payloads)
~/.codex/cache/, models_cache.json, .codex-global-state.json*
~/.codex/memories/, plugins/, skills/, vendor_imports/, sqlite/
state_*.sqlite-shm, state_*.sqlite-wal
all tables in state_*.sqlite EXCEPT the three listed below
```

### 7.2 Rollout JSONL collector

Identical algorithm to Claude Code's JSONL collector (§5). Per-file byte cursor, split-at-last-newline, ship verbatim. The only difference is the path glob:

```
glob: ~/.codex/sessions/*/*/*/rollout-*.jsonl
```

Date-partitioned directories appear over time; the glob picks them up automatically. No special handling.

### 7.3 SQLite sidecar collector

**Three tables in scope, all read-only.** Skip-listed at the unit-test level so they can never accidentally include other tables.

| Table | Why we ship it |
|---|---|
| `threads` | Thread metadata: cwd, git_*, model, sandbox_policy, approval_mode, reasoning_effort, tokens_used, title, cli_version. The backend joins this to rollout records by `id`. |
| `thread_dynamic_tools` | Per-thread dynamic tool inventory (name, description, schema, namespace). |
| `thread_spawn_edges` | Parent → child thread relationships for sub-agent spawns. Empty in observed data; ship when populated. |

**Tables we explicitly skip** (privacy or irrelevance): `_sqlx_migrations`, `agent_jobs`, `agent_job_items`, `jobs`, `backfill_state`, `stage1_outputs` (Codex-internal memory/summarization output — privacy-sensitive), `thread_goals`, `device_key_bindings`, `remote_control_enrollments`.

The cycle for each table:

```
1. tmp = "/tmp/proxai-codex-state-<uuid>.db"
2. sqlite3 "file:~/.codex/state_5.sqlite?mode=ro" "VACUUM INTO '<tmp>'"
3. for table in ['threads', 'thread_dynamic_tools', 'thread_spawn_edges']:
       row = SELECT last_max_rowid FROM source_watermark
             WHERE source_app='codex' AND source_path=<live_path> AND table_name=table
       offset = row.last_max_rowid OR 0
       rows = SELECT rowid, * FROM <table> WHERE rowid > <offset> ORDER BY rowid ASC
       if rows is empty: continue
       body = json.dumps([dict(row) for row in rows])
       redacted = redact(body)
       INSERT upload_batch with:
           source_kind = "sqlite_table_snapshot"
           watermark.kind = "rowid_range"
           watermark.start = rows[0].rowid; watermark.end = rows[-1].rowid
           watermark.table = table
           body_format = "sqlite_rows_json"
4. on 2xx for each table: advance per-table last_max_rowid
5. delete tmp file
```

### 7.4 What's in the body

JSON array of full rows, one object per row. Column names come from the SQLite schema. `body_format = "sqlite_rows_json"`.

### 7.5 Edge cases

| Case | Handling |
|---|---|
| `state_*.sqlite` doesn't exist yet | Codex hasn't been run; skip. |
| `state_5.sqlite` ↔ `state_6.sqlite` upgrade | Glob picks the highest-numbered. New file = new `source_path` = new watermark row. Backend gets clean cutover. |
| Schema drift inside a table (new column) | `dict(row)` includes it. Backend parser sees it. New column = new key in JSON; older parsers ignore. |
| Migrated row (rowid changes due to REPLACE) | Caught as a new high rowid on next poll. Backend upserts on its primary key. |
| `thread_spawn_edges` populates for the first time | Watermark starts at 0; everything ships in one go. |

---

## 8. Privacy & redaction (brief)

Three stages, all detailed in `01_INTRO.md` §3:

1. **Gateway, write-time.** Inline redaction during the read step (§4). `gitleaks` rule corpus + auth-header strip. Replaces matches with `[REDACTED:type]` before bytes leave the read function.
2. **Gateway, upload-time.** Independent regex pass with a different rule corpus (`detect-secrets`). Catches stage-1 bugs.
3. **Backend, ingest-time.** Third pass on receive. Catches stale-client rules.

The redaction module is **bundled with the gateway binary** in MVP. Updating means re-running the global install with `@latest` under whichever package manager produced the install (`bun`, `pnpm`, `yarn`, or `npm`), or `brew upgrade proxai/tap/proxai-gateway`. Stale-binary auto-pause (>180 days since release) is the safety net.

### 8.1 What about `agent_metadata` and the rest?

The DTO ships **only** raw bytes from the source files. The `AgentCallRecord.agent_metadata` dict is constructed by the **backend parser**, not the gateway. The gateway has no knowledge of typed schemas.

### 8.2 What about externalized tool-result blobs?

Claude Code writes large tool outputs to `<session-dir>/tool-results/<hash>.txt`. Two ship modes considered:

- **Ship always:** simpler, but bloats traffic when tool outputs are huge and not referenced by analytics.
- **Ship lazy:** ship the referencing JSONL line first; backend asks for the blob only when it actually needs it.

**MVP decision: ship always, capped.** Each blob >256 KB is truncated to 256 KB + `<...truncated, original size N B...>` marker. Backend knows it's truncated; can re-fetch the full blob on demand by sending an explicit request to the gateway (post-MVP capability — for now, truncation is permanent).

### 8.3 `blob_snapshot` source kind

For these external blob files (Claude Code tool-results, Cursor `workspace.json`, Codex `session_index.jsonl`):

```
source_kind:    "blob_snapshot"
watermark:      { kind: "mtime", start: <last_seen_mtime_ns>, end: <cur_mtime_ns> }
body_format:    "raw_bytes"
body:           full file content (up to size cap)
```

Watermark: file mtime. Re-ship when mtime changes; otherwise skip. Backend dedups on `(source_path_hash, end mtime)`.

---

## 9. Failure modes and recovery

| Mode | Symptom | Recovery |
|---|---|---|
| Network down | 5xx / connection refused | Exponential backoff per §3.4. Watermark stays put. Gateway keeps trying. |
| Backend rejects (4xx) | Auth failure, malformed DTO | Surface in `proxai-gateway status`. Admin attention. |
| Source file locked | `read()` EAGAIN / EBUSY | Skip this source this cycle; retry next. |
| Disk full (local buffer) | Cannot insert `upload_batch` | Pause gateway via `~/.proxai/PAUSED`. Log loudly. |
| Clock skew | `captured_at_utc` is wrong | Backend treats it as gateway-self-reported (just a hint). Order is by watermark, not clock. |
| Gateway crash mid-poll | Some `pending` rows never reached the network | Restart picks them up — same `capture_id`, same body, same watermark. Idempotent. |
| Gateway crash post-2xx, pre-watermark-advance | Same range shipped twice on next poll | Backend dedup by `capture_id` (gateway uses the same one — see §9.1). |

### 9.1 Crash safety on watermark advancement

The risk: gateway gets `2xx`, then crashes before advancing the watermark. Next poll re-reads the same range and re-ships under a new `capture_id`. Backend gets two records for the same source bytes.

**Mitigation:** the gateway writes the `2xx` response and the watermark advance in the **same SQLite transaction**. Either both or neither. If the transaction commits, watermark is advanced. If it doesn't, next poll re-reads — and we generate the **same** `capture_id` from `(source_app, source_path_hash, source_inode, watermark.start, watermark.end)` deterministically (UUIDv7 with a hash-based override, or a separate deterministic id). Backend dedup is identity.

This makes `capture_id` deterministic from the source-position tuple, not random. UUIDv7 was a placeholder above; the actual computation is:

```
capture_id = uuidv5(namespace='proxai-gateway',
                   name=f"{source_app}|{source_path_hash}|{source_inode or 0}|"
                        f"{watermark.kind}|{watermark.start}|{watermark.end}|"
                        f"{watermark.table or ''}")
```

UUIDv5 is content-addressed; same source position always produces the same id. No race, no duplicates.

---

## 10. MVP scope

### In

1. JSONL byte-cursor collector (Claude Code, Codex rollouts).
2. SQLite KV snapshot collector (Cursor `cursorDiskKV`, filtered to `composerData:` / `bubbleId:` prefixes).
3. SQLite table snapshot collector (Codex `state_*.sqlite` for three tables).
4. Blob snapshot collector (Claude tool-results, Cursor `workspace.json`, Codex `session_index.jsonl`).
5. Two-stage gateway redaction (gitleaks + detect-secrets, bundled rules).
6. SQLite local buffer with `file_cursor` / `source_watermark` / `upload_batch` tables.
7. HTTPS uploader with exponential backoff and deterministic `capture_id`.
8. Skip-list enforced by unit test (paths and table names that must never leave the host).
9. Stale-binary auto-pause (>180 days since release → stop uploading).

### Out (deferred)

- HTTP proxy / MITM mode (Phase 2; in case real-time freshness matters).
- Hooks-based collection (Phase 2; sub-poll-interval freshness for Claude Code).
- On-demand blob fetch endpoint (Phase 2; for very large tool-results).
- Linux / Windows (Phase 3).
- Antigravity (Phase 4 — encrypted at rest, deferred indefinitely).

---

## 11. Open questions

1. **Truncation cap for tool-result blobs.** 256 KB chosen as a reasonable default; revisit after one week of beta to see distribution of real blob sizes.
2. **Backend rate-limiting policy.** Does `proxai_nest` accept unlimited batches per host or rate-limit? If rate-limited, gateway needs a queue depth strategy. Negotiate with backend team before MVP code-freeze.
3. **`host_id` salt rotation.** Currently the salt is a fixed install-time value. If a user wipes / reinstalls, they appear as a new host. Acceptable for MVP; revisit if needed.
4. **`agent_schema_version` extraction.** Some sources (Codex sidecar) make this trivial; others (Claude Code) require sniffing the first record of a chunk. If a chunk has no records (rare), we ship the last-seen value. Document this exception in the parser handoff.
5. **Compression algorithm.** zstd chosen for speed + ratio. Alternative: gzip for ubiquity. Probably not worth thinking about unless the backend has a preference.

---

## 12. Handoff to the backend team

What `proxai_nest` needs to implement to consume what this gateway sends:

1. **`POST /v1/raw_records` endpoint** with the DTO in §3.2 and the response semantics in §3.4.
2. **Raw blob storage** keyed by `capture_id`. Idempotent on receive (existing `capture_id` → 200, no overwrite).
3. **Per-`source_kind` parser dispatch.** Three parsers (one per agent), each consuming the `body` according to its `body_format` and feeding into the `AgentCallRecord` shape per `04_AGENT_CALL_RECORD.md` and `05_AGENT_CALL_RECORD_MAPPING.md`. The DTO fields map to the record's `capture` group as: `source_app` → `capture.agent` (enum), `agent_schema_version` → `capture.agent_version`, `source_path` → `capture.source_path`, `captured_at_utc` → `capture.captured_at_utc`, `gateway_version` → `capture.gateway_version`.
4. **Linear-stream reassembly** for `jsonl_append`: sort batches by `(host_id, source_path_hash, source_inode, watermark.start)`. Concatenate. Parse. The output is a stream of records ordered by source position.
5. **Snapshot reassembly** for `sqlite_kv_snapshot` / `sqlite_table_snapshot`: each batch is a list of rows; backend mirrors the source SQLite shape and triggers parser passes when source-side completion conditions are met (per parser, defined in `05_AGENT_CALL_RECORD_MAPPING.md`).
6. **Re-redaction on receive** as the third privacy stage (§8). Even if gateway redaction misses something, backend stage-3 catches it before persistence.
7. **Re-parse on demand** for schema upgrades. Bump the parser, re-run over object-stored raw blobs, upsert by `AgentCallRecord.id`. Per `04_AGENT_CALL_RECORD.md` §2.10, the deterministic id makes this safe.

Anything beyond this — `AgentCallRecord` schema details, sub-agent embedding rules, token estimation, project resolution — lives in `04_AGENT_CALL_RECORD.md` and `05_AGENT_CALL_RECORD_MAPPING.md` and is not the gateway's concern.
