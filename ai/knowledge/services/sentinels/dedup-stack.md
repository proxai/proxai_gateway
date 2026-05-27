# The 5-Layer Dedup Stack

The gateway has five independent layers that prevent duplicate
`AgentCallRecord`s from reaching the backend. Each layer catches a
different failure mode. Removing any one layer regresses correctness in
a specific scenario; they are not redundant.

## Layer 1: source_path hash (file identity)

`source_path_hash` is `sha256(absolute_path)`. It is part of every
`source_cursors` primary key and every batch row. Two captures of "the
same file" must produce the same hash; renaming the file produces a
different hash and a fresh cursor.

**Catches**: per-file watermark state stays correctly scoped. Two
files at different paths can have overlapping byte ranges without
either's watermark interfering.

**Layered with `source_inode`** (POSIX only): a file rotated under the
same name keeps the path-hash but gets a new inode. The cursor key
includes both, so a rotated file gets a fresh capture from
`watermark_end = 0`. The `sentinel` of inode 0 (`NO_INODE_SENTINEL`)
covers sources without inode tracking (sqlite snapshots).

Source: `buffer/cursors.ts:35-60` (UPSERT key includes inode + table).

## Layer 2: per-chat / per-file collect filter

Each source's `collect.ts` applies a per-source filter before the redact
step. For claude-code, this is `isDialogueRecord` — rejecting tool
internals, system noise, and non-dialogue rows. For codex state, it's
the `thread_spawn_edges` allow-list. For cursor, it's the
`composerData:` / `bubbleId:` / `agentKv:blob:` key prefix allow-list.

**Catches**: capturing the same logical conversation through multiple
file-views. Codex stores the same chat in `rollout-*.jsonl` *and* in
`state_*.sqlite/threads`. The sub-agent flag plus the
`thread_spawn_edges` pre-query keeps the gateway from double-shipping
the same dialog through two source variants.

Source: `src/sources/<agent>/collect.ts`, `polling/poll-cycle.ts`.

## Layer 3: watermark (intra-file dedup)

`watermark_start` and `watermark_end` define a half-open range per
batch. Within a single source file, the cursor advances strictly
forward (`ai/knowledge/services/sentinels/watermark-pattern.md`). A
restart mid-capture replays from the last committed cursor, regenerating
any in-flight batches with fresh `capture_id`s.

**Catches**: intra-file replay. Without watermarks, the gateway would
either re-ship every record from offset 0 every cycle, or risk missing
records around a restart boundary.

Source: `buffer/cursors.ts`, `src/sources/<agent>/collect.ts`.

## Layer 4: sentinel files (process-level gates)

`AUTH_FAILED` and `BUFFER_FULL` short-circuit the capture and drain
cycles entirely. While these are not literally "dedup", they prevent
the daemon from re-attempting work it knows will fail (and potentially
producing duplicate side-effects in logs and metrics).

**Catches**: pathological retry loops. An expired key would otherwise
produce a tight loop of `capture → upload → 401 → mark failed →
re-capture` writing thousands of duplicate failed batches per minute.
The `AUTH_FAILED` sentinel pins the daemon until human intervention.

Source: `ai/knowledge/services/sentinels/sentinel-lifecycle.md`.

## Layer 5: server-side `jobId` (BullMQ idempotency)

The `capture_id` (UUIDv7) is the **primary key** on `upload_batches`
locally **and** the BullMQ `jobId` server-side. UUIDv7 is time-sortable
which keeps BullMQ's job ordering aligned with capture order. When the
same `capture_id` is delivered twice (network retry that hit the server
both times), BullMQ rejects the second job before any handler runs.

The DTO validator gates this:
- `validate.ts:26-28` rejects any `capture_id` that is not a valid
  UUIDv7. Other UUID versions would not guarantee time-sort.
- `markBatchDelivered.idempotentOnServer` is set from the server's
  response — `true` indicates the server detected a duplicate `jobId`
  and accepted the re-delivery as a no-op. The local receipt records
  this flag for forensic review.

**Catches**: network-layer duplicates. The HTTP client retries
transient failures (`upload-batch.ts:50-130`). If a request was
delivered but the response was lost, the retry would re-send the same
batch. The server's `jobId` check turns the second delivery into a
no-op rather than a duplicate record.

## What no layer catches (by design)

Two **independent** captures of overlapping content via different
`source_path_hash` values (e.g. user copies the JSONL file to a new
location and runs both daemons) is **not** deduplicated. Both hashes
have independent cursors, both ship the data, both `capture_id`s are
unique, the server stores both. This is intentional: the gateway
treats the file path as a primary key for "what stream is this", and
two paths are two streams.

[source: src/services/buffer/cursors.ts, src/services/buffer/buffer.constants.ts, src/services/contract/validate.ts, src/services/uploader/upload-batch.ts, src/sources/*/collect.ts]
