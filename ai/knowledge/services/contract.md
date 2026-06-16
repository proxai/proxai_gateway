# contract

`src/services/contract/` is the wire contract with proxai_nest. It owns the `RawRecordDTO` shape, the `SOURCE_VARIANTS` enumeration, body-size budgets, and `validateRawRecordDTO` — the last-chance guard that runs in `HttpClient.uploadRawRecord` before every POST.

## DTO shape

`RawRecordDTO` is flat snake_case JSON. There is no envelope, no batch wrapper — one record per POST.

```ts
interface RawRecordDTO {
  capture_id: string;
  host_id: string;
  source_app: 'claude-code' | 'cursor' | 'codex' | 'claude-desktop' | 'gemini';
  source_platform?: 'claude-code-cli' | 'claude-code-desktop' | 'claude-cowork-desktop' | 'codex-cli' | 'codex-desktop' | 'cursor-ide' | 'cursor-cli' | 'antigravity-cli' | 'antigravity-ide' | null;
  source_kind: 'jsonl_append' | 'sqlite_kv_snapshot' | 'sqlite_table_snapshot';
  source_path: string;
  source_path_hash: string;
  source_inode: number | null;
  watermark: Watermark;
  agent_schema_version: string;
  gateway_version: string;
  captured_at_utc: string;
  body_format: 'jsonl' | 'kv_pairs_json' | 'sqlite_rows_json';
  body_compression: 'zstd';
  body: string;
}
```

`Watermark` is one of two shapes:

| Kind | Fields | Used by |
| --- | --- | --- |
| `byte_range` | `{ kind: 'byte_range', start, end, table: null }` | claude-code, codex rollouts, claude-desktop |
| `rowid_range` | `{ kind: 'rowid_range', start, end, table: string \| null }` | cursor (table: null), codex state (table: 'threads' / 'thread_dynamic_tools' / 'thread_spawn_edges'), gemini (table: 'trajectory_meta' / 'steps' / 'trajectory_metadata_blob') |

## `SOURCE_VARIANTS` matrix

Six entries; canonical enumeration of allowed `(sourceApp, sourceKind, bodyFormat, watermarkKind, watermarkTableRequired)` tuples. Server and gateway both validate against this matrix.

| sourceApp | sourceKind | bodyFormat | watermarkKind | tableRequired |
| --- | --- | --- | --- | --- |
| `claude-code` | `jsonl_append` | `jsonl` | `byte_range` | false |
| `codex` | `jsonl_append` | `jsonl` | `byte_range` | false |
| `cursor` | `sqlite_kv_snapshot` | `kv_pairs_json` | `rowid_range` | false |
| `codex` | `sqlite_table_snapshot` | `sqlite_rows_json` | `rowid_range` | true |
| `claude-desktop` | `jsonl_append` | `jsonl` | `byte_range` | false |
| `gemini` | `sqlite_table_snapshot` | `sqlite_rows_json` | `rowid_range` | true |

Codex appears twice (rollouts JSONL + state SQLite). Adding a new agent requires a new entry here and a matching test case in `validateRawRecordDTO` tests.

## Size budgets

| Constant | Value | Applies to |
| --- | --- | --- |
| `BODY_MAX_COMPRESSED_BYTES` | `2 * 1024^2` (2 MiB) | post-zstd, pre-base64 (the wire-payload limit; `validateBody` checks decoded base64 size) |
| `BODY_TARGET_COMPRESSED_BYTES` | `floor(0.9 * MAX)` (~1.8 MiB) | splitters aim under this so a single round of redaction overhead doesn't push past max |
| `BODY_MAX_DECOMPRESSED_BYTES` | `10 * 1024^2` (10 MiB) | post-redaction text size; rows over this go to quarantine |
| `BODY_TARGET_DECOMPRESSED_BYTES` | `floor(0.9 * MAX)` (~9 MiB) | default `maxDecompressedBytes` used by `resolveMaxDecompressed` when `config.toml` omits it |
| `MAX_SAFE_WATERMARK` | `Number.MAX_SAFE_INTEGER` | watermark range check |
| `DEFAULT_ZSTD_LEVEL` | `3` | hard-coded; not configurable |

## `validateRawRecordDTO`

An `asserts value is RawRecordDTO` predicate. Throws `ValidationError` (which the uploader classifies as **fatal** — never retried). Checks, in order:

1. Object shape (not null, not array).
2. `capture_id` matches UUIDv7 via `isUuidV7`.
3. `host_id`, `source_path`, `source_path_hash`, `agent_schema_version`, `gateway_version` are non-empty strings.
4. `source_app`, `source_kind`, `body_format`, `body_compression` are in their respective `VALID_*` lists. `source_platform` (if provided) is in `VALID_SOURCE_PLATFORMS`.
5. `watermark` is an object with a recognised `kind`.
6. `(source_app, source_kind, body_format, watermark.kind)` exists in `SOURCE_VARIANTS` — else "tuple is not in the allowed matrix".
7. `validateWatermark(wm, variant)`:
   - `start`, `end` non-negative integers ≤ `MAX_SAFE_WATERMARK`, `start < end`.
   - `byte_range` → `table` MUST be `null`.
   - `sqlite_table_snapshot` (table required) → `table` MUST be a non-empty string in `VALID_CODEX_TABLES` (for Codex) or `VALID_GEMINI_TABLES` (for Gemini).
   - `sqlite_kv_snapshot` → `table` MUST be `null`.
8. `validateSourceInode(value, variant)`: SQLite snapshot variants MUST have `source_inode: null`; JSONL variants accept `null` or non-negative integer.
9. `validateCapturedAtUtc(value)`: matches `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$` AND `Date.parse` is finite. Z suffix is required.
10. `validateBody(value)`: non-empty string, regex `^[A-Za-z0-9+/]+={0,2}$`, length divisible by 4, decoded byte length ≤ `BODY_MAX_COMPRESSED_BYTES`.

## Error handling

- `validateRawRecordDTO` throws `ValidationError`. In `uploader/upload-batch.ts:131`, `ValidationError` and any other `GatewayError` subclass is mapped to `{ kind: 'fatal' }`. Fatals: increment attempts, set `status = 'failed'`, write `lastError`, log `upload.fatal`. Never retried.
- Server-side validation failures (`HTTP 400` with no `error: 'watermark_regression'` body) produce a different `ValidationError` via `dispatchSuccessOrThrow` and are also fatal.
- Server-side watermark regression (`HTTP 400` with `error: 'watermark_regression'` + `current_server_watermark_end` + `source_path_hash`) produces `WatermarkRegressionError`, which the uploader handles as **recovered** (not fatal): `setCursorFromRegression` writes the server's watermark onto the cursor row, `deleteBatch` drops the stale batch, log `upload.watermark_recovered`.

## Index module

`src/services/contract/index.ts` re-exports only constants, types, and `validateRawRecordDTO`. Nothing else lives here — no client logic, no formatting. Pure types-and-invariants.

[source: src/services/contract/contract.types.ts:1-66; src/services/contract/contract.constants.ts:13-116; src/services/contract/validate.ts:21-199; src/services/uploader/upload-batch.ts:110-232; src/services/http/error-mapping.ts:15-81]
