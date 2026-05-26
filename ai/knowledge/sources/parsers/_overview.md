# Source Parsers — Overview

Each `src/sources/<agent>/` directory exports a discover/collect pair that turns one
agent tool's on-disk session data into `NewBatch` rows in the local buffer DB.
Five `SOURCE_VARIANTS` are registered for the four agents (codex contributes both a
rollout JSONL variant and a state sqlite variant).

## Discover/collect surface (uniform)

Every parser exposes the same two-call pipeline used by the polling layer:

| Function (per source)            | Signature                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| `discoverXxxFiles(baseDir, opts)` | `(string, { minimumMtime?: Date \| null, ... }) => Promise<DiscoveredXxxFile[]>`     |
| `collectXxxFile(file, ctx)`       | `(DiscoveredXxxFile, XxxCollectorContext) => Promise<XxxCollectorResult>`             |

`DiscoveredXxxFile` is the same shape across all four sources: `sourcePath`,
`sourcePathHash` (sha256), `inode`, `sizeBytes`, `lastModifiedMs`.

## File-watch layout

| Source       | Base dir (POSIX default)                         | Glob pattern(s)                                               | File kind |
| ------------ | ------------------------------------------------ | ------------------------------------------------------------- | --------- |
| claude-code  | `~/.claude/projects`                             | `*/*.jsonl` (+ `*/*/subagents/*.jsonl` if sub-agent flag on) | JSONL append |
| codex rollout| `~/.codex`                                       | `sessions/*/*/*/rollout-*.jsonl`                              | JSONL append |
| codex state  | `~/.codex`                                       | `state_*.sqlite` (highest-numbered only)                      | sqlite (table snapshot) |
| cursor       | `~/Library/Application Support/Cursor/User` (macOS); `~/.config/Cursor/User` (linux); `%APPDATA%/Cursor/User` (win32) | `globalStorage/state.vscdb` + `workspaceStorage/*/state.vscdb` | sqlite (KV snapshot) |
| gemini-cli   | `~/.gemini/tmp`                                  | `*/chats/**/*.jsonl`                                          | JSONL append (with header line) |

The cursor base dir is the only one whose POSIX default branches on `process.platform`.
All globs are pinned-depth — `**/*.jsonl` is never used so we never silently start
capturing unknown content.

## Output batch shape (`NewBatch`, services/buffer/buffer.types.ts:11)

Every parser writes the same `NewBatch` interface into the buffer:

```ts
interface NewBatch {
  captureId: string;            // UUIDv7 generated at insert
  sourceApp: SourceApp;         // 'claude-code' | 'codex' | 'cursor' | 'gemini-cli'
  sourceKind: SourceKind;       // 'jsonl_append' | 'sqlite_kv_snapshot' | 'sqlite_table_snapshot'
  sourcePath: string;
  sourcePathHash: string;
  sourceInode: number | null;
  watermarkKind: WatermarkKind; // 'byte_range' | 'rowid_range'
  watermarkStart: number;
  watermarkEnd: number;
  watermarkTable: string | null;
  agentSchemaVersion: string;
  gatewayVersion: string;
  capturedAtUtc: string;
  bodyFormat: BodyFormat;       // 'jsonl' | 'kv_pairs_json' | 'sqlite_rows_json'
  bodyCompression: BodyCompression; // always 'zstd'
  body: Uint8Array;             // zstd(redact(filtered_text))
}
```

The wire DTO `RawRecordDTO` (contract.types.ts:37) is the same shape with `body`
base64-encoded.

## Where each parser diverges

| Concern              | claude-code            | codex rollout          | codex state            | cursor                 | gemini-cli             |
| -------------------- | ---------------------- | ---------------------- | ---------------------- | ---------------------- | ---------------------- |
| Body format          | `jsonl`                | `jsonl`                | `sqlite_rows_json`     | `kv_pairs_json`        | `jsonl`                |
| Watermark kind       | `byte_range`           | `byte_range`           | `rowid_range`          | `rowid_range`          | `byte_range`           |
| `watermarkTable`     | `null`                 | `null`                 | `'threads'` or `'thread_spawn_edges'` | `null`  | `null`                 |
| `sourceInode`        | file inode             | file inode             | `null`                 | `null`                 | file inode             |
| Splitter             | `splitJsonlAtBoundary` | `splitJsonlAtBoundary` | `splitRowsByCompressedSize` | `splitRowsByCompressedSize` | `splitJsonlAtBoundary` |
| Version source       | embedded `version`     | embedded `payload.cli_version` (first line) | `threads.cli_version` (max-rowid) | `_v` from composer + bubble rows | `gemini --version` subprocess |
| Version fallback     | `'unknown'`            | `'unknown'`            | `'unknown'`            | `'unknown:unknown'`    | `'gemini-cli/unknown'` |
| Initial watermark    | `0`                    | `0`                    | `1` (rowid space)      | `1` (rowid space)      | past header (≤64 KiB)  |
| Quarantine on oversize | throws fatal         | throws fatal           | `recordQuarantine` + advance cursor | `recordQuarantine` + advance cursor | throws fatal |
| VACUUM rehash        | n/a                    | n/a                    | yes (`detectVacuum`)   | yes (`detectVacuum`)   | n/a                    |
| Snapshot before read | n/a                    | n/a                    | `snapshotSqlite`       | `snapshotSqlite`       | n/a                    |
| Sub-agent exclude    | second glob skipped    | `thread_spawn_edges` join skip | n/a            | sql-level (currently no-op) | n/a                  |

JSONL parsers re-use a single in-collector `splitJsonlAtBoundary`; sqlite parsers
re-use `splitRowsByCompressedSize`. Both binary-search the largest prefix that fits
both the 2 MiB compressed and 10 MiB decompressed budgets defined in
`contract.constants.ts:78-84`.

## Parser version scheme

`agentSchemaVersion` is the **upstream agent's** version (the tool that wrote the
file), not a gateway-internal parser version. The gateway propagates whatever the
agent claims; gateway version travels separately in `gatewayVersion`. There is no
per-parser semver — parsers are versioned alongside the gateway binary (CalVer).

[source: src/sources/claude-code/collect.ts:200-403; src/sources/codex/collect-rollout.ts:97-303; src/sources/codex/collect-state.ts:21-141; src/sources/cursor/collect.ts:51-195; src/sources/gemini-cli/collect.ts:153-376; src/services/contract/contract.constants.ts:40-89; src/services/buffer/buffer.types.ts:11-28; src/services/polling/default-sources.ts]
